import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// Playwright compiles this file as CommonJS (the shell is not "type": "module", because Electron's sandboxed preload must be CJS).
const appDir = join(__dirname, '..');

interface Launched {
  app: ElectronApplication;
  page: Page;
  requests: string[];
}

/**
 * Starts the built app with its own user-data folder. The app reopens the last workspace on its own, and otherwise shows
 * only the toolbar. The folder dialogs are answered, one folder per dialog, with `workspace` (none by default);
 * several folders are separated by the path delimiter.
 */
async function launch(userData: string, workspace?: string, files: string[] = []): Promise<Launched> {
  const app = await electron.launch({
    // GitHub's Linux runners restrict unprivileged user namespaces, which Chromium's own process sandbox needs.
    args: [appDir, `--user-data-dir=${userData}`, ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [])],
    cwd: appDir,
    env: { ...process.env, AB_E2E_PICK_FOLDER: workspace ?? '', AB_E2E_PICK_FILE: files.join(delimiter), ELECTRON_RENDERER_URL: '' },
  });
  const page = await app.firstWindow();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.waitForLoadState('domcontentloaded');
  // The window opens maximized: wait for that (and for the page to take the window's size), so that nothing measured
  // in a test changes size under it.
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false)).toBe(true);
  await expect
    .poll(async () => {
      const [inner, content] = await Promise.all([page.evaluate(() => window.innerWidth), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds().width)]);
      return inner === content;
    })
    .toBe(true);
  return { app, page, requests };
}

/** Starts the app and opens the workspace folder `workspace` with the open-workspace button (the folder dialog is answered by AB_E2E_PICK_FOLDER). */
async function launchOpened(userData: string, workspace: string, files: string[] = []): Promise<Launched> {
  const launched = await launch(userData, workspace, files);
  await launched.page.getByTestId('open-workspace').click();
  await expect(launched.page.getByTestId('workspace')).toBeVisible();
  return launched;
}

interface NodeFields {
  title?: string;
  description?: string;
  body?: string;
  /** The fields to tick (of those with text); the others are unticked. Absent: the dialog's own ticks. */
  show?: ('title' | 'description' | 'body')[];
  /** Click "File" (the native file dialog is answered by AB_E2E_PICK_FILE). */
  file?: boolean;
  copy?: boolean;
}

/** The Add button, then the node dialog filled in with `fields`, then "Create". */
async function createNode(page: Page, fields: NodeFields): Promise<void> {
  await page.getByTestId('add').click();
  const dialog = page.getByTestId('node-dialog');
  for (const field of ['title', 'description', 'body'] as const) if (fields[field] !== undefined) await dialog.getByTestId(`node-${field}`).fill(fields[field]!);
  if (fields.file) {
    await dialog.getByTestId('node-file').click();
    await expect(dialog.getByTestId('node-path')).toBeVisible();
  }
  if (fields.copy !== undefined) await dialog.getByTestId('node-copy').setChecked(fields.copy);
  if (fields.show) {
    for (const field of ['title', 'description', 'body'] as const) {
      const box = dialog.getByTestId(`show-${field}`);
      if (await box.isEnabled()) await box.setChecked(fields.show.includes(field));
    }
  }
  await dialog.getByTestId('node-submit').click();
  await expect(dialog).toHaveCount(0);
}

/** A text node as written to workspace.json, showing its title. */
/** The distance from a point to a box (0 inside it). */
const distanceTo = (p: { x: number; y: number }, box: DOMRect) => Math.hypot(Math.max(box.left - p.x, 0, p.x - box.right), Math.max(box.top - p.y, 0, p.y - box.bottom));
const plain = (id: string, title: string) => ({ id, addedAt: '2026-01-01T00:00:00.000Z', title, description: null, body: null, display: ['title'] });

/** A 1x1 PNG, base64-encoded. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The node list's entry whose text is `text` (a string matches the whole text). */
function entry(page: Page, text: string | RegExp) {
  const pattern = typeof text === 'string' ? new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : text;
  return page.getByTestId('node-entry').filter({ has: page.getByTestId('node-entry-text').filter({ hasText: pattern }) });
}

/** Closes the link dialog that opens when a link is created. */
async function closeLinkDialog(page: Page): Promise<void> {
  await expect(page.getByTestId('weight-dialog')).toBeVisible();
  await page.getByTestId('weight-save').click();
  await expect(page.getByTestId('weight-dialog')).toHaveCount(0);
}

/**
 * Links the node whose entry text is `source` to the one whose entry text is `target` with the node popup, closes the
 * link dialog that opens, and waits for both to be on the canvas.
 */
async function link(page: Page, source: string | RegExp, target: string | RegExp): Promise<void> {
  const [sourceId, targetId] = await Promise.all([entry(page, source).getAttribute('data-node-id'), entry(page, target).getAttribute('data-node-id')]);
  await entry(page, source).click({ button: 'right' });
  await page.getByTestId('node-menu-link').hover();
  await page.locator(`[data-testid=node-menu-item][data-node-id="${targetId}"]`).click();
  await expect(page.getByTestId('node-menu')).toHaveCount(0);
  await closeLinkDialog(page);
  for (const id of [sourceId, targetId]) await expect(page.getByTestId('workspace').locator(`[data-node-id="${id}"]`)).toHaveCount(1);
}

async function withTemp<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ab-electron-e2e-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test.describe('electron shell: workspace', () => {
  test('shows only the toolbar until a workspace folder is opened, and reopens it after a restart', async () => {
    await withTemp(async (dir) => {
      const userData = join(dir, 'userData');
      const workspace = join(dir, 'My Workspace');

      const first = await launch(userData, workspace);
      // Nothing is asked for: the screen holds only the toolbar (a new-workspace, an open-workspace, an add, an import, a
      // lay-out-from-scratch and a node-types button, with icons and no text), and no workspace is open.
      await expect(first.page.getByTestId('toolbar')).toBeVisible();
      await expect(first.page.getByTestId('workspace')).toHaveCount(0);
      expect((await first.page.locator('body').innerText()).trim()).toBe('');
      await expect(first.page.locator('input, h1, a')).toHaveCount(0);
      await expect(first.page.locator('[data-testid=toolbar] button')).toHaveCount(6);
      expect(await first.page.locator('[data-testid=toolbar] button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-testid')))).toEqual(['new-workspace', 'open-workspace', 'add', 'import', 'relayout', 'node-types']);

      await first.page.getByTestId('open-workspace').click();
      await expect(first.page.getByTestId('workspace')).toBeVisible();

      // The folder holds a workspace.json, and a .lock while the app is open: nothing else.
      expect((await readdir(workspace)).sort()).toEqual(['.lock', 'workspace.json']);
      const info = JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8'));
      expect(info.appId).toBe('terrane');
      expect(info.nodes).toEqual([]);

      await first.app.close();
      expect(await readdir(workspace)).not.toContain('.lock'); // quitting releases the lock

      // The current workspace is reopened on its own: the folder dialog is not needed (nothing answers it here).
      const second = await launch(userData, join(dir, 'never-picked'));
      await expect(second.page.getByTestId('workspace')).toBeVisible();
      expect(await readdir(dir)).not.toContain('never-picked');
      await second.app.close();
    });
  });

  test('new workspace asks for a name and a location, creates the folder there as a workspace, and reopens it after a restart', async () => {
    await withTemp(async (dir) => {
      const userData = join(dir, 'userData');
      const location = join(dir, 'Locations');
      await mkdir(location);
      // The folder dialog is answered with `location` (for the "Location" button).
      const first = await launch(userData, location);
      try {
        await first.page.getByTestId('new-workspace').click();
        const dialog = first.page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled(); // a name is required
        await dialog.getByLabel('Name').fill('a/b');
        await expect(dialog.getByRole('alert')).not.toHaveText('');
        await dialog.getByLabel('Name').fill('Fresh');
        await dialog.getByRole('button', { name: 'Location' }).click();
        await expect(dialog.getByTestId('workspace-location')).toHaveText(location);
        await dialog.getByRole('button', { name: 'Create' }).click();
        await expect(first.page.getByTestId('workspace')).toBeVisible();
        await expect(first.page.getByRole('dialog')).toHaveCount(0);

        // The new folder is a Terrane workspace like any other: a workspace.json, and a .lock while the app is open.
        expect((await readdir(join(location, 'Fresh'))).sort()).toEqual(['.lock', 'workspace.json']);
        expect(JSON.parse(await readFile(join(location, 'Fresh', 'workspace.json'), 'utf8')).appId).toBe('terrane');
        const settings = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'));
        expect(settings).toEqual({ lastWorkspace: join(location, 'Fresh'), workspaceLocation: location });
      } finally {
        await first.app.close().catch(() => undefined);
      }

      const second = await launch(userData, join(dir, 'never-picked'));
      await expect(second.page.getByTestId('workspace')).toBeVisible();
      await second.app.close();
    });
  });

  test('a new workspace cannot take the name of a folder that exists, and nothing is opened', async () => {
    await withTemp(async (dir) => {
      const location = join(dir, 'Locations');
      await mkdir(join(location, 'Taken'), { recursive: true });
      const { app, page } = await launch(join(dir, 'userData'), location);
      try {
        await page.getByTestId('new-workspace').click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: 'Location' }).click();
        await dialog.getByLabel('Name').fill('Taken');
        await dialog.getByRole('button', { name: 'Create' }).click();
        await expect(dialog.getByRole('alert')).toContainText('already exists');
        await expect(page.getByTestId('workspace')).toHaveCount(0);
        expect(await readdir(join(location, 'Taken'))).toEqual([]);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('a chosen folder without a workspace.json becomes a workspace, whatever else it holds', async () => {
    await withTemp(async (dir) => {
      const folder = join(dir, 'Downloads');
      await mkdir(folder);
      await writeFile(join(folder, 'existing.txt'), 'keep me');
      const { app, page } = await launchOpened(join(dir, 'userData'), folder);
      await expect(page.getByTestId('workspace')).toBeVisible();
      await expect(page.getByTestId('error')).toHaveCount(0);
      expect((await readdir(folder)).filter((name) => name !== '.lock').sort()).toEqual(['existing.txt', 'workspace.json']);
      expect(await readFile(join(folder, 'existing.txt'), 'utf8')).toBe('keep me');
      await app.close();
    });
  });

  test('Add opens the node dialog: Title ticked by default, a checkbox disabled while its field is empty, Create disabled until there is a title no other node has and a ticked field has text', async () => {
    await withTemp(async (dir) => {
      const workspace = join(dir, 'ws');
      const { app, page } = await launchOpened(join(dir, 'userData'), workspace);
      try {
        await page.getByTestId('add').click();
        const dialog = page.getByTestId('node-dialog');
        await expect(dialog).toBeVisible();
        expect(await Promise.all(['title', 'description', 'body'].map((field) => dialog.getByTestId(`node-${field}`).getAttribute('rows')))).toEqual(['1', '2', '10']);
        await expect(dialog.getByTestId('show-title')).toBeChecked();
        await expect(dialog.getByTestId('show-title')).toBeDisabled(); // ticked, but its field is empty
        await expect(dialog.getByTestId('show-description')).not.toBeChecked();
        await expect(dialog.getByTestId('show-description')).toBeDisabled();
        await expect(dialog.getByTestId('show-body')).not.toBeChecked();
        await expect(dialog.getByTestId('show-body')).toBeDisabled();
        await expect(dialog.getByTestId('node-copy')).not.toBeChecked();
        await expect(dialog.getByTestId('node-path')).toHaveCount(0);
        await expect(dialog.getByTestId('node-submit')).toHaveText('Create');
        await expect(dialog.getByTestId('node-submit')).toBeDisabled();

        // Text in an unticked field is not enough; ticking it is, once the node has a title (which need not be shown).
        await dialog.getByTestId('node-body').fill('just a body');
        await expect(dialog.getByTestId('show-body')).toBeEnabled();
        await expect(dialog.getByTestId('node-submit')).toBeDisabled();
        await dialog.getByTestId('show-body').check();
        await expect(dialog.getByTestId('node-submit')).toBeDisabled(); // no title
        await dialog.getByTestId('node-title').fill('   ');
        await expect(dialog.getByTestId('node-submit')).toBeDisabled(); // only spaces are no title
        await dialog.getByTestId('node-title').fill(' first ');
        await dialog.getByTestId('show-title').uncheck();
        await expect(dialog.getByTestId('node-submit')).toBeEnabled();
        await dialog.getByTestId('node-submit').click();
        await expect(dialog).toHaveCount(0);

        // A new node has no link: it is in the unlinked part of the node list, not on the canvas.
        const entries = page.getByTestId('unlinked-nodes').getByTestId('node-entry-text');
        await expect(entries).toHaveText(['just a body']);
        await expect(page.getByTestId('node')).toHaveCount(0);
        const info = JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8'));
        expect(info.appId).toBe('terrane'); // the rest of workspace.json is kept
        expect(info.nodes).toEqual([{ id: expect.any(String), addedAt: expect.any(String), title: 'first', description: null, body: 'just a body', display: ['body'], type: 'default', properties: {} }]);

        // Ctrl+N opens the same dialog. Another node's title cannot be used: the dialog says so, and Create is disabled.
        await page.keyboard.press('Control+n');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByTestId('node-submit')).toHaveText('Create');
        await expect(dialog.getByTestId('node-title-taken')).toHaveCount(0);
        await dialog.getByTestId('node-title').fill('first ');
        await expect(dialog.getByTestId('node-title-taken')).toBeVisible();
        await expect(dialog.getByTestId('node-submit')).toBeDisabled();
        await dialog.getByTestId('node-title').fill('First'); // titles are told apart by case
        await expect(dialog.getByTestId('node-title-taken')).toHaveCount(0);
        await expect(dialog.getByTestId('node-submit')).toBeEnabled();

        // Cancelling it creates nothing.
        await dialog.getByTestId('node-title').fill('never');
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(entries).toHaveCount(1);

        // Right-clicking the canvas's background opens the canvas popup, with only "Create node" for now; clicking off
        // cancels it, and "Create node" opens the node dialog for a new node.
        const canvasMenu = page.getByTestId('canvas-menu');
        await page.getByTestId('workspace').click({ button: 'right', position: { x: 10, y: 10 } });
        await expect(canvasMenu.getByRole('menuitem')).toHaveText(['Create node']);
        expect(await canvasMenu.boundingBox()).toMatchObject({ x: expect.closeTo((await page.getByTestId('workspace').boundingBox())!.x + 10, 0) });
        await page.mouse.click(5, 5);
        await expect(canvasMenu).toHaveCount(0);
        await expect(page.locator('dialog[open]')).toHaveCount(0);
        await page.getByTestId('workspace').click({ button: 'right', position: { x: 10, y: 10 } });
        await page.getByTestId('canvas-menu-create-node').click();
        await expect(canvasMenu).toHaveCount(0);
        await expect(dialog).toBeVisible();
        await expect(dialog.getByTestId('node-submit')).toHaveText('Create');
        await expect(dialog.getByTestId('node-title')).toHaveValue('');
        await dialog.getByTestId('node-title').fill('from the canvas');
        await dialog.getByTestId('node-submit').click();
        await expect(dialog).toHaveCount(0);
        await expect(entries).toHaveText(['just a body', 'from the canvas']);

        // Once linked, the node is on the canvas: the text handler's display, 162 wide and only as tall as its one line needs.
        await createNode(page, { title: 'other' });
        await link(page, 'just a body', 'other');
        const node = page.getByTestId('node').first();
        await expect(node).toHaveText('just a body');
        await expect(node).toHaveAttribute('data-handler', 'text');
        const box = await node.boundingBox();
        expect(Math.round(box!.width)).toBe(162);
        expect(box!.height).toBeLessThan(100);

        // Right-clicking a display opens the node popup, not the canvas popup.
        await node.click({ button: 'right' });
        await expect(page.getByTestId('node-menu')).toBeVisible();
        await expect(canvasMenu).toHaveCount(0);
        await page.keyboard.press('Escape');
        await page.mouse.click(5, 5);
        await expect(page.getByTestId('node-menu')).toHaveCount(0);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('a node shows its ticked fields in the order title, description, body, each on its own line and without labels; a long body is cut at 127 characters', async () => {
    await withTemp(async (dir) => {
      const { app, page } = await launchOpened(join(dir, 'userData'), join(dir, 'ws'));
      try {
        await createNode(page, { title: 'T', description: 'D', body: 'b'.repeat(200), show: ['title', 'description', 'body'] });
        await createNode(page, { title: 'T2', description: 'D2', body: 'short', show: ['title', 'body'] });
        await createNode(page, { title: 'T3', description: 'D3', body: 'short', show: ['description', 'body'] });
        await createNode(page, { title: 'T4', description: 'D4', body: 'short', show: ['title'] });
        // Only linked nodes are on the canvas.
        await link(page, /^T\s+D\s/, /^T2\s/);
        await link(page, /^D3\s/, 'T4');
        const lines = (index: number) => page.getByTestId('node').nth(index).getByTestId('node-line');
        await expect(lines(0)).toHaveText(['T', 'D', `${'b'.repeat(127)}…`]);
        await expect(lines(1)).toHaveText(['T2', 'short']);
        await expect(lines(2)).toHaveText(['D3', 'short']);
        await expect(lines(3)).toHaveText(['T4']);
        await expect(page.getByTestId('workspace')).not.toContainText('Title');
        // Each line is below the one before it.
        const tops = await lines(0).evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
        expect(tops[1]).toBeGreaterThan(tops[0]);
        expect(tops[2]).toBeGreaterThan(tops[1]);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('a file chosen in the node dialog is left where it is unless copying is ticked; its name fills an empty title', async () => {
    await withTemp(async (dir) => {
      const userData = join(dir, 'userData');
      const workspace = join(dir, 'ws');
      await mkdir(join(dir, 'source'));
      const source = join(dir, 'source', 'report.txt');
      await writeFile(source, 'hello');

      // The file dialog is answered with the same file three times, then cancelled.
      const first = await launchOpened(userData, workspace, [source, source, source, '']);
      const { page } = first;
      try {
        // Not copied (the default): the path is the original's, and the file's name becomes the empty title.
        await page.getByTestId('add').click();
        const dialog = page.getByTestId('node-dialog');
        await dialog.getByTestId('node-file').click();
        await expect(dialog.getByTestId('node-path')).toHaveText(source);
        await expect(dialog.getByTestId('node-title')).toHaveValue('report.txt');
        await dialog.getByTestId('node-submit').click();
        // The nodes have no links, so they are only in the node list.
        const entries = page.getByTestId('node-entry-text');
        await expect(entries).toHaveText(['report.txt']);

        // A title already typed is kept; copied into the workspace, a clashing name is numbered. A file name that another
        // node has as its title becomes the title with an integer at its end.
        await createNode(page, { title: 'mine', file: true, copy: true });
        await createNode(page, { file: true, copy: true });
        await expect(entries).toHaveText(['report.txt', 'mine', 'report.txt2']);

        // A cancelled file dialog chooses nothing.
        await page.getByTestId('add').click();
        await dialog.getByTestId('node-file').click();
        await expect(dialog.getByTestId('node-path')).toHaveCount(0);
        await page.keyboard.press('Escape');

        expect(await readFile(source, 'utf8')).toBe('hello'); // the original is untouched
        expect((await readdir(workspace)).sort()).toEqual(['.lock', 'report (1).txt', 'report.txt', 'workspace.json']);
        const info = JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8'));
        expect(info.nodes).toMatchObject([
          { title: 'report.txt', display: ['title'], filename: 'report.txt', path: source },
          { title: 'mine', filename: 'report.txt', path: 'report.txt' },
          { title: 'report.txt2', filename: 'report (1).txt', path: 'report (1).txt' },
        ]);
        expect(info.nodes.some((node: object) => 'size' in node)).toBe(false);
      } finally {
        await first.app.close().catch(() => undefined);
      }

      // The nodes come back when the workspace is reopened.
      const second = await launch(userData, join(dir, 'never-picked'));
      await expect(second.page.getByTestId('node-entry-text')).toHaveText(['report.txt', 'mine', 'report.txt2']);
      await second.app.close();
    });
  });

  test('a file is shown by the handler for its type: jpeg, png and svg by the image handler, anything else by the default one', async () => {
    await withTemp(async (dir) => {
      await mkdir(join(dir, 'source'));
      const names = ['photo.PNG', 'pic.jpeg', 'logo.svg', 'notes.txt', 'noextension'];
      const sources = names.map((name) => join(dir, 'source', name));
      for (const source of sources) await writeFile(source, 'x');
      const { app, page } = await launchOpened(join(dir, 'userData'), join(dir, 'ws'), sources);
      try {
        for (let i = 1; i <= names.length; i += 1) {
          await createNode(page, { file: true });
          await expect(page.getByTestId('node-entry')).toHaveCount(i);
        }
        // Linked in a chain, so every node is on the canvas.
        for (let i = 1; i < names.length; i += 1) await link(page, names[i - 1], names[i]);
        await expect(page.getByTestId('node')).toHaveText(names);
        const handlers = await page.getByTestId('node').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-handler')));
        expect(handlers).toEqual(['image', 'image', 'image', 'default', 'default']);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('the image display is portrait (the image in a square above, the text in the bottom 20%), and shows no image while the body is shown', async () => {
    await withTemp(async (dir) => {
      await mkdir(join(dir, 'source'));
      const png = join(dir, 'source', 'dot.png');
      await writeFile(png, Buffer.from(PNG, 'base64'));
      const { app, page } = await launchOpened(join(dir, 'userData'), join(dir, 'ws'), [png]);
      try {
        await createNode(page, { file: true, copy: true });
        // Linked to another node, so it is on the canvas.
        await createNode(page, { title: 'other' });
        await link(page, 'dot.png', 'other');
        const node = page.locator('[data-testid=node][data-handler=image]');
        await expect(node).toHaveCount(1);
        const image = node.locator('img');
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(1);
        await expect(page.getByTestId('layout-wait')).toHaveCount(0); // the display is not moved while it is measured

        const box = async (locator: typeof node) => {
          const b = (await locator.boundingBox())!;
          return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
        };
        const whole = await box(node);
        const top = await box(node.getByTestId('node-image'));
        const bottom = await box(node.getByTestId('node-text'));
        expect(whole.height).toBeGreaterThan(whole.width); // portrait
        expect(top).toMatchObject({ x: whole.x, y: whole.y, width: top.height }); // a square at the top
        expect(bottom.height).toBe(Math.round(whole.height * 0.2)); // the text takes 20% of the height
        expect(top.height + bottom.height).toBe(whole.height);
        expect(bottom.y).toBe(top.y + top.height);
        await expect(node.getByTestId('node-text')).toHaveText('dot.png');
        expect(await image.evaluate((element) => getComputedStyle(element).objectFit)).toBe('contain'); // aspect ratio kept
        const shown = await box(image);
        expect(shown.width).toBeLessThanOrEqual(top.width);
        expect(shown.height).toBeLessThanOrEqual(top.height);

        // With the body shown, there is no image: a 100x100 square with the lines.
        await node.dblclick();
        await page.getByTestId('node-body').fill('a body');
        await page.getByTestId('show-body').check();
        await page.getByTestId('node-submit').click();
        await expect(node.getByTestId('node-line')).toHaveText(['dot.png', 'a body']);
        await expect(node.locator('img')).toHaveCount(0);
        expect(await box(node)).toMatchObject({ width: 100, height: 100 });
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test("double-clicking a node's entry in the node list opens the dialog filled in, with Save; saving replaces the node, cancelling changes nothing", async () => {
    await withTemp(async (dir) => {
      const workspace = join(dir, 'ws');
      await mkdir(join(dir, 'source'));
      const source = join(dir, 'source', 'later.txt');
      await writeFile(source, 'x');
      const { app, page } = await launchOpened(join(dir, 'userData'), workspace, [source]);
      try {
        await createNode(page, { title: 'remember', body: 'the milk' });
        const before = JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8')).nodes[0];
        const node = page.getByTestId('node-entry');
        const text = node.getByTestId('node-entry-text');

        await node.dblclick();
        const dialog = page.getByTestId('node-dialog');
        await expect(dialog.getByTestId('node-title')).toHaveValue('remember');
        await expect(dialog.getByTestId('node-body')).toHaveValue('the milk');
        await expect(dialog.getByTestId('show-title')).toBeChecked();
        await expect(dialog.getByTestId('show-body')).not.toBeChecked();
        await expect(dialog.getByTestId('node-submit')).toHaveText('Save');
        await dialog.getByTestId('node-title').fill('changed');
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(text).toHaveText('remember');

        // Everything can be changed, including giving the node a file.
        await node.dblclick();
        await dialog.getByTestId('node-title').fill('');
        await dialog.getByTestId('node-description').fill('described');
        await dialog.getByTestId('show-description').check();
        await dialog.getByTestId('show-body').check();
        await dialog.getByTestId('node-file').click();
        await expect(dialog.getByTestId('node-title')).toHaveValue('later.txt'); // the emptied title takes the file's name
        await dialog.getByTestId('node-submit').click();
        await expect(dialog).toHaveCount(0);
        await expect(node).toHaveCount(1);
        await expect(text).toHaveText('later.txt described the milk');
        const after = JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8')).nodes;
        expect(after).toEqual([
          { id: before.id, addedAt: before.addedAt, title: 'later.txt', description: 'described', body: 'the milk', display: ['title', 'description', 'body'], type: 'default', properties: {}, filename: 'later.txt', path: source },
        ]);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('editing a node whose file was copied in: copying stays ticked and disabled until another file is chosen, and saving then asks whether to keep the old copy', async () => {
    await withTemp(async (dir) => {
      const workspace = join(dir, 'ws');
      await mkdir(join(dir, 'source'));
      const [a, b, c] = ['a.txt', 'b.txt', 'c.txt'].map((name) => join(dir, 'source', name));
      for (const file of [a, b, c]) await writeFile(file, 'x');
      const { app, page } = await launchOpened(join(dir, 'userData'), workspace, [a, b, c]);
      const nodes = async () => JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8')).nodes;
      try {
        await createNode(page, { file: true, copy: true });
        const node = page.getByTestId('node-entry');
        const dialog = page.getByTestId('node-dialog');

        await node.dblclick();
        await expect(dialog.getByTestId('node-path')).toHaveText('a.txt');
        await expect(dialog.getByTestId('node-copy')).toBeChecked();
        await expect(dialog.getByTestId('node-copy')).toBeDisabled();
        await dialog.getByTestId('node-file').click();
        await expect(dialog.getByTestId('node-path')).toHaveText(b);
        await expect(dialog.getByTestId('node-copy')).toBeEnabled();
        await expect(dialog.getByTestId('node-title')).toHaveValue('a.txt'); // not empty, so kept
        await dialog.getByTestId('node-submit').click();
        const ask = page.getByTestId('keep-copy-dialog');
        await expect(ask).toBeVisible();
        await ask.getByTestId('delete-copy').click();
        await expect(dialog).toHaveCount(0);
        await expect.poll(async () => (await readdir(workspace)).sort()).toEqual(['.lock', 'b.txt', 'workspace.json']);
        expect(await nodes()).toMatchObject([{ filename: 'b.txt', path: 'b.txt' }]);

        // Not copied this time, and the old copy kept.
        await node.dblclick();
        await dialog.getByTestId('node-file').click();
        await expect(dialog.getByTestId('node-path')).toHaveText(c);
        await dialog.getByTestId('node-copy').uncheck();
        await dialog.getByTestId('node-submit').click();
        await ask.getByTestId('keep-copy').click();
        await expect(dialog).toHaveCount(0);
        await expect.poll(async () => (await nodes())[0].path).toBe(c);
        expect((await readdir(workspace)).sort()).toEqual(['.lock', 'b.txt', 'workspace.json']);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('ticking copying for a node whose file is outside the workspace copies the file in on Save', async () => {
    await withTemp(async (dir) => {
      const workspace = join(dir, 'ws');
      await mkdir(join(dir, 'source'));
      const source = join(dir, 'source', 'outside.txt');
      await writeFile(source, 'x');
      const { app, page } = await launchOpened(join(dir, 'userData'), workspace, [source]);
      try {
        await createNode(page, { file: true });
        await page.getByTestId('node-entry').dblclick();
        const dialog = page.getByTestId('node-dialog');
        await expect(dialog.getByTestId('node-path')).toHaveText(source);
        await expect(dialog.getByTestId('node-copy')).not.toBeChecked();
        await dialog.getByTestId('node-copy').check();
        await dialog.getByTestId('node-submit').click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByTestId('keep-copy-dialog')).toHaveCount(0);
        await expect.poll(async () => JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8')).nodes[0].path).toBe('outside.txt');
        expect(await readFile(join(workspace, 'outside.txt'), 'utf8')).toBe('x');
        expect(await readFile(source, 'utf8')).toBe('x');
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('the layout keeps R1 (16 px between displays, and between lines and displays) and R2 (no line crosses a display), and a higher weight brings displays closer and makes lines shorter', async () => {
    await withTemp(async (dir) => {
      // A hub with three nodes at weight 10 and three at weight 1, and a chain at weight 5 between two of them.
      const folder = join(dir, 'ws');
      await mkdir(folder);
      const ids = ['hub', 'a', 'b', 'c', 'd', 'e', 'f', 'g'];
      const nodes = ids.map((id) => plain(id, id));
      const links = [
        ...['a', 'b', 'c'].map((id) => ({ id: `strong-${id}`, source: 'hub', target: id, weight: 10 })),
        ...['d', 'e', 'f'].map((id) => ({ id: `weak-${id}`, source: 'hub', target: id, weight: 1 })),
        { id: 'mid-1', source: 'a', target: 'g', weight: 5 },
        { id: 'mid-2', source: 'g', target: 'd', weight: 5 },
      ];
      await writeFile(join(folder, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links }));
      const { app, page } = await launchOpened(join(dir, 'userData'), folder);
      try {
        const canvas = page.getByTestId('workspace');
        const network = page.getByTestId('network');
        await expect(page.getByTestId('link')).toHaveCount(links.length);
        await expect(page.getByTestId('layout-wait')).toHaveCount(0);
        // At zoom 1 every display is where the layout put it, at full size.
        const area = (await canvas.boundingBox())!;
        await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
        for (let i = 0; i < 30 && Number(await network.getAttribute('data-zoom')) < 1; i++) {
          await page.mouse.wheel(0, -400);
          await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        }
        await expect(network).toHaveAttribute('data-zoom', '1');

        const boxes = new Map(await canvas.locator('[data-node-id]').evaluateAll((elements) => elements.map((element) => [element.getAttribute('data-node-id')!, element.getBoundingClientRect().toJSON() as DOMRect] as const)));
        const lines = new Map(
          await page.getByTestId('link').evaluateAll((groups) =>
            groups.map((group) => {
              const svg = group.querySelector('[data-testid=link-line]') as unknown as SVGGeometryElement;
              const m = svg.getScreenCTM()!;
              const length = svg.getTotalLength();
              const points = Array.from({ length: 201 }, (_, k) => {
                const p = svg.getPointAtLength((length * k) / 200);
                return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
              });
              return [group.getAttribute('data-link-id')!, { length, points }] as const;
            }),
          ),
        );

        // R1.
        const all = [...boxes.values()];
        for (let i = 0; i < all.length; i++)
          for (let j = i + 1; j < all.length; j++) {
            const [p, q] = [all[i], all[j]];
            expect(Math.max(Math.max(p.left, q.left) - Math.min(p.right, q.right), Math.max(p.top, q.top) - Math.min(p.bottom, q.bottom))).toBeGreaterThanOrEqual(16 - 0.5);
          }
        // R1 for lines, and so R2: every point of a line is at least 16 px (plus half the line's width) from every display
        // but its own two.
        for (const link of links) {
          for (const [id, box] of boxes) {
            if (id === link.source || id === link.target) continue;
            const nearest = Math.min(...lines.get(link.id)!.points.map((p) => distanceTo(p, box)));
            expect(nearest, `${link.id} comes within ${nearest} px of ${id}`).toBeGreaterThanOrEqual(17 - 0.5);
          }
        }
        // P1 and P2: the weight-10 links are shorter, centre to centre and as lines, than the weight-1 links.
        const centre = (id: string) => ({ x: boxes.get(id)!.left + boxes.get(id)!.width / 2, y: boxes.get(id)!.top + boxes.get(id)!.height / 2 });
        const apart = (id: string) => Math.hypot(centre('hub').x - centre(id).x, centre('hub').y - centre(id).y);
        const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
        expect(mean(['a', 'b', 'c'].map(apart))).toBeLessThan(mean(['d', 'e', 'f'].map(apart)));
        expect(mean(['a', 'b', 'c'].map((id) => lines.get(`strong-${id}`)!.length))).toBeLessThan(mean(['d', 'e', 'f'].map((id) => lines.get(`weak-${id}`)!.length)));
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('a workspace opens zoomed right out; the wheel zooms between that and zoom 1; displays keep their full size unless the rules need them smaller, R1 and R2 hold at every zoom, and links keep their width', async () => {
    await withTemp(async (dir) => {
      // A chain of nodes long enough not to fit on the canvas at zoom 1.
      const folder = join(dir, 'ws');
      await mkdir(folder);
      const ids = Array.from({ length: 16 }, (_, i) => `n${i}`);
      const nodes = ids.map((id) => plain(id, `node ${id}`));
      const links = ids.slice(1).map((id, i) => ({ id: `link-${id}`, source: ids[i], target: id, weight: 5 }));
      await writeFile(join(folder, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links }));
      const { app, page } = await launchOpened(join(dir, 'userData'), folder);
      try {
        const canvas = page.getByTestId('workspace');
        const network = page.getByTestId('network');
        await expect(page.getByTestId('link')).toHaveCount(links.length);
        await expect(page.getByTestId('layout-wait')).toHaveCount(0);

        const area = (await canvas.boundingBox())!;
        const fullSizes = await canvas.locator('[data-node-id]').evaluateAll((elements) => elements.map((element) => (element as HTMLElement).offsetWidth));
        const order = await canvas.locator('[data-node-id]').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-node-id')!));
        const shown = async () => {
          const boxes = await canvas.locator('[data-node-id]').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON() as DOMRect));
          const scales = (await canvas.locator('[data-node-id]').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-scale')))).map(Number);
          const lines = await page.getByTestId('link').evaluateAll((groups) =>
            groups.map((group) => {
              const path = group.querySelector('[data-testid=link-line]')!;
              const svg = path as unknown as SVGGeometryElement;
              const m = svg.getScreenCTM()!;
              const length = svg.getTotalLength();
              const points = Array.from({ length: 101 }, (_, k) => {
                const p = svg.getPointAtLength((length * k) / 100);
                return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
              });
              return { id: group.getAttribute('data-link-id')!, width: Math.hypot(m.a, m.b) * Number.parseFloat(getComputedStyle(path).strokeWidth), points };
            }),
          );
          return { boxes, scales, lines, zoom: Number(await network.getAttribute('data-zoom')), network: (await network.boundingBox())! };
        };
        const wheel = async (deltaY: number) => {
          await page.mouse.wheel(0, deltaY);
          await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        };
        const gap = (p: DOMRect, q: DOMRect) => Math.max(Math.max(p.left, q.left) - Math.min(p.right, q.right), Math.max(p.top, q.top) - Math.min(p.bottom, q.bottom));
        // R1 and R2 hold; each display is shown at its factor, and is smaller than full size only if it is at its gap from
        // another (16 px, or 35 px where it makes room for lines), so the rules need it no smaller; links keep their width.
        const check = ({ boxes, scales, lines }: Awaited<ReturnType<typeof shown>>) => {
          boxes.forEach((box, i) => {
            expect(box.width).toBeCloseTo(fullSizes[i] * scales[i], 0);
            const nearest = Math.min(...boxes.filter((_, j) => j !== i).map((other) => gap(box, other)));
            expect(nearest).toBeGreaterThanOrEqual(16 - 0.5);
            if (scales[i] < 1 - 1e-3) expect(nearest).toBeLessThanOrEqual(35 + 1);
          });
          for (const line of lines) {
            expect(line.width).toBeCloseTo(2, 1);
            const link = links.find((l) => l.id === line.id)!;
            boxes.forEach((box, i) => {
              if (order[i] === link.source || order[i] === link.target) return;
              const nearest = Math.min(...line.points.map((p) => distanceTo(p, box)));
              expect(nearest, `${line.id} comes within ${nearest} px of ${order[i]}`).toBeGreaterThanOrEqual(17 - 0.5);
            });
          }
        };

        // Opened, the network is zoomed right out and all of it is on the canvas.
        const out = await shown();
        expect(out.zoom).toBeLessThan(1);
        expect(out.network.x).toBeGreaterThanOrEqual(area.x - 1);
        expect(out.network.y).toBeGreaterThanOrEqual(area.y - 1);
        expect(out.network.x + out.network.width).toBeLessThanOrEqual(area.x + area.width + 1);
        expect(out.network.y + out.network.height).toBeLessThanOrEqual(area.y + area.height + 1);
        check(out);

        // Down: already as far out as it goes.
        await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
        await wheel(200);
        expect(Number(await network.getAttribute('data-zoom'))).toBe(out.zoom);

        // Up a little, then far enough: zoom 1 and no further, every display at its full size.
        await wheel(-200);
        const between = await shown();
        expect(between.zoom).toBeGreaterThan(out.zoom);
        check(between);
        for (let i = 0; i < 20; i++) await wheel(-200);
        const full = await shown();
        expect(full.zoom).toBe(1);
        expect(full.scales.every((scale) => scale === 1)).toBe(true);
        check(full);
        await wheel(-200);
        expect(Number(await network.getAttribute('data-zoom'))).toBe(1);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('the canvas shows no scrollbars; pressing on empty space shows a grab hand, and dragging pans the network', async () => {
    await withTemp(async (dir) => {
      const folder = join(dir, 'ws');
      await mkdir(folder);
      const nodes = [plain('one', 'one'), plain('two', 'two')];
      await writeFile(join(folder, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links: [{ id: 'link-1', source: 'one', target: 'two', weight: 10 }] }));
      const { app, page } = await launchOpened(join(dir, 'userData'), folder);
      try {
        const canvas = page.getByTestId('workspace');
        const network = page.getByTestId('network');
        await expect(page.getByTestId('link')).toHaveCount(1);
        await expect(page.getByTestId('layout-wait')).toHaveCount(0);
        expect(await canvas.evaluate((element) => getComputedStyle(element).overflow)).toBe('hidden');

        const before = (await network.boundingBox())!;
        const area = (await canvas.boundingBox())!;
        // A corner of the canvas, clear of the network.
        const start = { x: area.x + 5, y: area.y + 5 };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        expect(await canvas.evaluate((element) => getComputedStyle(element).cursor)).toBe('grab');
        await page.mouse.move(start.x + 40, start.y + 25, { steps: 4 });
        await page.mouse.up();
        expect(await canvas.evaluate((element) => getComputedStyle(element).cursor)).not.toBe('grab');

        const after = (await network.boundingBox())!;
        expect(after.x - before.x).toBeCloseTo(40, 0);
        expect(after.y - before.y).toBeCloseTo(25, 0);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('dragging from a link line selects no text, and a press on empty canvas clears any selection', async () => {
    await withTemp(async (dir) => {
      const folder = join(dir, 'ws');
      await mkdir(folder);
      const nodes = [plain('one', 'one'), plain('two', 'two')];
      await writeFile(join(folder, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links: [{ id: 'link-1', source: 'one', target: 'two', weight: 10 }] }));
      const { app, page } = await launchOpened(join(dir, 'userData'), folder);
      try {
        await expect(page.getByTestId('link')).toHaveCount(1);
        await expect(page.getByTestId('layout-wait')).toHaveCount(0);
        const selection = () => page.evaluate(() => window.getSelection()?.toString() ?? '');

        // From the middle of the line across the target's display.
        const middle = await page.getByTestId('link-line').evaluate((path) => {
          const svg = path as unknown as SVGGeometryElement;
          const matrix = svg.getScreenCTM()!;
          const point = svg.getPointAtLength(svg.getTotalLength() / 2);
          return { x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f };
        });
        const target = (await page.getByTestId('workspace').locator('[data-node-id="two"]').boundingBox())!;
        await page.mouse.move(middle.x, middle.y);
        await page.mouse.down();
        await page.mouse.move(target.x + target.width - 2, target.y + target.height / 2, { steps: 8 });
        await page.mouse.up();
        expect(await selection()).toBe('');

        // A selection made some other way is cleared by a press on empty canvas.
        await page.evaluate(() => {
          const text = document.querySelector('[data-testid=workspace] [data-node-id="one"]')!;
          window.getSelection()!.selectAllChildren(text);
        });
        expect(await selection()).not.toBe('');
        const area = (await page.getByTestId('workspace').boundingBox())!;
        await page.mouse.click(area.x + 5, area.y + 5);
        expect(await selection()).toBe('');
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('the node list (10% of the width) has a search box above the unlinked nodes and, below a splitter, the linked ones; only linked nodes are on the canvas', async () => {
    await withTemp(async (dir) => {
      const folder = join(dir, 'ws');
      await mkdir(folder);
      await writeFile(join(folder, 'dot.png'), Buffer.from(PNG, 'base64'));
      const long = `delta ${'x'.repeat(60)}`;
      const nodes = [plain('a', 'alpha'), plain('b', 'beta'), plain('c', 'gamma'), plain('d', long), { ...plain('e', 'dot.png'), filename: 'dot.png', path: 'dot.png' }];
      await writeFile(join(folder, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links: [{ id: 'ab', source: 'a', target: 'b', weight: 10 }] }));
      const { app, page } = await launchOpened(join(dir, 'userData'), folder);
      try {
        const unlinked = page.getByTestId('unlinked-nodes').getByTestId('node-entry-text');
        const linked = page.getByTestId('linked-nodes').getByTestId('node-entry-text');
        await expect(unlinked).toHaveText(['gamma', long, 'dot.png']);
        await expect(linked).toHaveText(['alpha', 'beta']);
        await expect(page.getByTestId('node')).toHaveText(['alpha', 'beta']);

        // The node list takes 10% of the width, and the link list 10% of the rest (less the splitter); the canvas the rest.
        const width = await page.evaluate(() => window.innerWidth);
        expect(Math.abs((await page.getByTestId('node-list').boundingBox())!.width - width * 0.1)).toBeLessThan(1);
        const splitter = page.locator('[role=separator][aria-orientation=vertical]').first();
        const splitterWidth = (await splitter.boundingBox())!.width;
        const rest = width * 0.9 - splitterWidth;
        expect(Math.abs((await page.getByTestId('link-list').boundingBox())!.width - rest / 9)).toBeLessThan(1);
        expect(Math.abs((await page.getByTestId('workspace').boundingBox())!.width - (rest - rest / 9 - splitterWidth))).toBeLessThan(1);

        // The unlinked part is sized to its entries: the splitter between the parts sits under the last one shown, or
        // under the search box when none is.
        const search = page.getByTestId('node-search');
        const between = page.locator('[role=separator][aria-orientation=horizontal]');
        const splitterUnder = async (above: ReturnType<Page['getByTestId']>, gap = 0) =>
          expect
            .poll(async () => {
              const box = (await above.boundingBox())!;
              return Math.abs((await between.boundingBox())!.y - (box.y + box.height + gap));
            })
            .toBeLessThan(1);
        await splitterUnder(page.getByTestId('unlinked-nodes').getByTestId('node-entry').last());

        // Each change to the search text filters both parts, ignoring case.
        await search.fill('t');
        await expect(unlinked).toHaveText([long, 'dot.png']);
        await expect(linked).toHaveText(['beta']);
        await splitterUnder(page.getByTestId('unlinked-nodes').getByTestId('node-entry').last());
        await search.fill('TA');
        await expect(unlinked).toHaveText([long]);
        await expect(linked).toHaveText(['beta']);
        await splitterUnder(page.getByTestId('unlinked-nodes').getByTestId('node-entry').last());
        await search.fill('beta');
        await expect(unlinked).toHaveCount(0);
        await expect(linked).toHaveText(['beta']);
        await splitterUnder(search, 4); // the search box's bottom margin
        await search.fill('');
        await expect(unlinked).toHaveText(['gamma', long, 'dot.png']);
        await expect(linked).toHaveText(['alpha', 'beta']);
        await splitterUnder(page.getByTestId('unlinked-nodes').getByTestId('node-entry').last());

        // An entry is one line, cut off; clicking it expands it to show all of its text, wrapped, and clicking it again collapses it.
        const longEntry = page.locator('[data-testid=node-entry][data-node-id=d]');
        const text = longEntry.getByTestId('node-entry-text');
        const oneLine = (await text.boundingBox())!.height;
        expect(await text.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
        await longEntry.click();
        await expect(longEntry).toHaveAttribute('data-expanded', 'true');
        expect((await text.boundingBox())!.height).toBeGreaterThan(oneLine * 1.5);
        expect(await text.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await longEntry.click();
        await expect(longEntry).toHaveAttribute('data-expanded', 'false');

        // Expanded, an entry also shows the node's properties, each labelled, an empty one as a dash, and its type; collapsed, it hides them.
        const shortEntry = page.locator('[data-testid=node-entry][data-node-id=c]');
        const properties = shortEntry.getByTestId('node-entry-property');
        await expect(shortEntry.getByTestId('node-entry-properties')).toHaveCount(0);
        await shortEntry.click();
        await expect(properties.locator('dt')).toHaveText(['Title', 'Description', 'Body', 'Type']);
        await expect(shortEntry.locator('[data-property=type] dd')).toHaveText('Default');
        await expect(properties.locator('dd').first()).toHaveText('gamma');
        await expect(shortEntry.locator('[data-property=description] dd')).toHaveText('—');
        await splitterUnder(page.getByTestId('unlinked-nodes').getByTestId('node-entry').last()); // the unlinked part grows to fit
        await shortEntry.click();
        await expect(shortEntry.getByTestId('node-entry-properties')).toHaveCount(0);
        // A file node shows the same properties: not its file or path.
        const fileEntry = page.locator('[data-testid=node-entry][data-node-id=e]');
        await fileEntry.click();
        await expect(fileEntry.getByTestId('node-entry-property').locator('dt')).toHaveText(['Title', 'Description', 'Body', 'Type']);
        await fileEntry.click();
        // The entry has no toggle arrow, and a double-click opens the node without leaving the entry expanded.
        await expect(shortEntry.locator('button')).toHaveCount(0);
        await shortEntry.dblclick();
        await expect(page.getByTestId('node-dialog')).toBeVisible();
        await expect(shortEntry).toHaveAttribute('data-expanded', 'false');
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('node-dialog')).toHaveCount(0);

        // An image node's entry shows its image only while expanded.
        const imageEntry = page.locator('[data-testid=node-entry][data-node-id=e]');
        await expect(imageEntry.getByTestId('node-entry-image')).toHaveCount(0);
        await imageEntry.click();
        await expect.poll(() => imageEntry.locator('img').evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(1);

        // Both splitters can be dragged.
        const drag = async (locator: typeof splitter, x: number, y: number) => {
          const box = (await locator.boundingBox())!;
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(x, y, { steps: 5 });
          await page.mouse.up();
        };
        const splitterBox = (await splitter.boundingBox())!;
        await drag(splitter, 300, splitterBox.y + splitterBox.height / 2);
        expect(Math.abs((await page.getByTestId('node-list').boundingBox())!.width - 300)).toBeLessThan(1);
        const betweenBox = (await between.boundingBox())!;
        await drag(between, betweenBox.x + betweenBox.width / 2, betweenBox.y - 50);
        expect(Math.abs((await between.boundingBox())!.y - (betweenBox.y - 50))).toBeLessThan(1);
        // The splitter between the parts cannot be dragged below the last unlinked entry, so no empty space opens under it.
        await drag(between, betweenBox.x + betweenBox.width / 2, betweenBox.y + 200);
        expect(Math.abs((await between.boundingBox())!.y - betweenBox.y)).toBeLessThan(1);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('right-clicking a node shows "Link to..." above "Delete"; hovering "Link to..." lists the nodes it is not linked to beside the popup, unlinked first; hovering one highlights it on the canvas, choosing one links to it, clicking off cancels', async () => {
    await withTemp(async (dir) => {
      const folder = join(dir, 'ws');
      await mkdir(folder);
      const long = `delta ${'x'.repeat(60)}`;
      const nodes = [plain('a', 'alpha'), plain('b', 'beta'), plain('c', 'gamma'), plain('d', long)];
      await writeFile(join(folder, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links: [{ id: 'ab', source: 'a', target: 'b', weight: 10 }] }));
      const { app, page } = await launchOpened(join(dir, 'userData'), folder);
      const links = async () => JSON.parse(await readFile(join(folder, 'workspace.json'), 'utf8')).links;
      const menu = page.getByTestId('node-menu');
      const items = page.getByTestId('node-menu-item');
      const ids = () => items.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-node-id')));
      const onCanvas = (id: string) => page.getByTestId('workspace').locator(`[data-node-id=${id}]`);
      const clickOff = async () => {
        const [width, height] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
        await page.mouse.click(width - 5, height - 5);
        await expect(menu).toHaveCount(0);
      };
      try {
        await expect(page.getByTestId('node')).toHaveText(['alpha', 'beta']);

        // From the node list: "Link to..." above "Delete", and no list of nodes until "Link to..." is hovered.
        await page.locator('[data-testid=node-entry][data-node-id=c]').click({ button: 'right' });
        await expect(menu).toBeVisible();
        await expect(menu.getByRole('menuitem')).toHaveText([/^Link to\.\.\./, 'Delete']);
        await expect(page.getByTestId('node-menu-targets')).toHaveCount(0);
        await page.getByTestId('node-menu-link').hover();
        // Beside the popup: every other node, unlinked first, each cut to its first 30 characters (spaces included).
        const [popup, beside] = [await menu.boundingBox(), await page.getByTestId('node-menu-targets').boundingBox()];
        expect(Math.abs(beside!.x - (popup!.x + popup!.width)) <= 2 || Math.abs(beside!.x + beside!.width - popup!.x) <= 2).toBe(true);
        expect(await ids()).toEqual(['d', 'a', 'b']);
        await expect(items).toHaveText([long.slice(0, 30), 'alpha', 'beta']);

        // Hovering a node highlights it on the canvas.
        await items.nth(1).hover();
        await expect(onCanvas('a')).toHaveAttribute('data-highlighted', 'true');
        await expect(onCanvas('b')).toHaveAttribute('data-highlighted', 'false');
        await items.nth(2).hover();
        await expect(onCanvas('a')).toHaveAttribute('data-highlighted', 'false');
        await expect(onCanvas('b')).toHaveAttribute('data-highlighted', 'true');

        // Clicking off the popup cancels: no link, nothing highlighted.
        await clickOff();
        await expect(onCanvas('b')).toHaveAttribute('data-highlighted', 'false');
        expect(await links()).toHaveLength(1);

        // Choosing a node links the right-clicked node to it: the source moves to the linked part and onto the canvas.
        await page.locator('[data-testid=node-entry][data-node-id=c]').click({ button: 'right' });
        await page.getByTestId('node-menu-link').hover();
        await page.locator('[data-testid=node-menu-item][data-node-id=a]').click();
        await expect(menu).toHaveCount(0);
        await closeLinkDialog(page);
        await expect(page.getByTestId('unlinked-nodes').getByTestId('node-entry-text')).toHaveText([long]);
        await expect(page.getByTestId('linked-nodes').getByTestId('node-entry-text')).toHaveText(['alpha', 'beta', 'gamma']);
        await expect(page.getByTestId('node')).toHaveText(['alpha', 'beta', 'gamma']);
        await expect.poll(links).toContainEqual(expect.objectContaining({ source: 'c', target: 'a', weight: 5, description: null }));

        // From the canvas: the same popup, without the right-clicked node or the nodes already linked to it, whichever
        // way the link goes (two nodes have at most one link).
        await onCanvas('b').click({ button: 'right' });
        await expect(menu).toBeVisible();
        await page.getByTestId('node-menu-link').hover();
        expect(await ids()).toEqual(['d', 'c']);
        await clickOff();
        await onCanvas('a').click({ button: 'right' });
        await expect(menu).toBeVisible();
        await page.getByTestId('node-menu-link').hover();
        expect(await ids()).toEqual(['d']);
        await clickOff();
        await expect(page.getByTestId('link-drag')).toHaveCount(0);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('"Delete" in the node popup (node list or canvas) or the node dialog deletes the node with its links and saved position; nodes left without a link move to the unlinked part and off the canvas', async () => {
    await withTemp(async (dir) => {
      const folder = join(dir, 'ws');
      await mkdir(folder);
      const nodes = [plain('a', 'alpha'), plain('b', 'beta'), plain('c', 'gamma'), plain('d', 'delta')];
      const links = [
        { id: 'ab', source: 'a', target: 'b', weight: 5 },
        { id: 'bc', source: 'b', target: 'c', weight: 5 },
        { id: 'cd', source: 'c', target: 'd', weight: 5 },
      ];
      await writeFile(join(folder, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links }));
      const { app, page } = await launchOpened(join(dir, 'userData'), folder);
      const saved = async () => JSON.parse(await readFile(join(folder, 'workspace.json'), 'utf8'));
      const ids = async () => (await saved()).nodes.map((node: { id: string }) => node.id);
      const linkIds = async () => (await saved()).links.map((link: { id: string }) => link.id);
      const unlinked = page.getByTestId('unlinked-nodes').getByTestId('node-entry-text');
      const linked = page.getByTestId('linked-nodes').getByTestId('node-entry-text');
      try {
        await expect(page.getByTestId('node')).toHaveText(['alpha', 'beta', 'gamma', 'delta']);
        await expect.poll(async () => Object.keys((await saved()).layout?.positions ?? {}).sort()).toEqual(['a', 'b', 'c', 'd']);

        // From the node list: beta goes, with both its links, so alpha is left without one.
        await page.locator('[data-testid=node-entry][data-node-id=b]').click({ button: 'right' });
        await page.getByTestId('node-menu-delete').click();
        await expect(page.getByTestId('node-menu')).toHaveCount(0);
        await expect.poll(ids).toEqual(['a', 'c', 'd']);
        expect(await linkIds()).toEqual(['cd']);
        await expect(unlinked).toHaveText(['alpha']);
        await expect(linked).toHaveText(['gamma', 'delta']);
        await expect(page.getByTestId('node')).toHaveText(['gamma', 'delta']);
        await expect.poll(async () => Object.keys((await saved()).layout.positions).sort()).toEqual(['c', 'd']);

        // From the canvas: gamma goes, so delta is left without a link and the canvas is empty.
        await page.getByTestId('workspace').locator('[data-node-id=c]').click({ button: 'right' });
        await page.getByTestId('node-menu-delete').click();
        await expect.poll(ids).toEqual(['a', 'd']);
        expect(await linkIds()).toEqual([]);
        await expect(unlinked).toHaveText(['alpha', 'delta']);
        await expect(linked).toHaveCount(0);
        await expect(page.getByTestId('node')).toHaveCount(0);

        // From the node dialog: Delete closes the dialog and deletes the node. A new node's dialog has no Delete.
        await page.locator('[data-testid=node-entry][data-node-id=a]').dblclick();
        await page.getByTestId('node-dialog').getByTestId('node-delete').click();
        await expect(page.getByTestId('node-dialog')).toHaveCount(0);
        await expect.poll(ids).toEqual(['d']);
        await expect(unlinked).toHaveText(['delta']);
        await page.getByTestId('add').click();
        await expect(page.getByTestId('node-dialog')).toBeVisible();
        await expect(page.getByTestId('node-delete')).toHaveCount(0);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('deleting a node whose file was copied into the workspace asks whether to keep the copy; Remove removes it, Keep leaves it, cancelling deletes nothing', async () => {
    await withTemp(async (dir) => {
      const workspace = join(dir, 'ws');
      await mkdir(join(dir, 'source'));
      const [a, b] = ['a.txt', 'b.txt'].map((name) => join(dir, 'source', name));
      for (const file of [a, b]) await writeFile(file, 'x');
      const { app, page } = await launchOpened(join(dir, 'userData'), workspace, [a, b]);
      const nodes = async () => JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8')).nodes;
      const ask = page.getByTestId('keep-copy-dialog');
      try {
        await createNode(page, { file: true, copy: true });
        await createNode(page, { file: true, copy: true });
        await expect.poll(async () => (await readdir(workspace)).sort()).toEqual(['.lock', 'a.txt', 'b.txt', 'workspace.json']);

        // Cancelled (Escape): nothing is deleted.
        await entry(page, 'a.txt').click({ button: 'right' });
        await page.getByTestId('node-menu-delete').click();
        await expect(ask).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(ask).toHaveCount(0);
        expect(await nodes()).toHaveLength(2);

        // Remove: the node and its copy go.
        await entry(page, 'a.txt').click({ button: 'right' });
        await page.getByTestId('node-menu-delete').click();
        await ask.getByTestId('delete-copy').click();
        await expect.poll(async () => (await nodes()).map((node: { path: string }) => node.path)).toEqual(['b.txt']);
        expect((await readdir(workspace)).sort()).toEqual(['.lock', 'b.txt', 'workspace.json']);

        // Keep, from the node dialog: the node goes, its copy stays.
        await entry(page, 'b.txt').dblclick();
        await page.getByTestId('node-delete').click();
        await ask.getByTestId('keep-copy').click();
        await expect(page.getByTestId('node-dialog')).toHaveCount(0);
        await expect.poll(nodes).toEqual([]);
        expect((await readdir(workspace)).sort()).toEqual(['.lock', 'b.txt', 'workspace.json']);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('right-clicking a link shows a popup with only "Delete"; it, and Delete in the link dialog, delete the link, and nodes left without a link move to the unlinked part', async () => {
    await withTemp(async (dir) => {
      const folder = join(dir, 'ws');
      await mkdir(folder);
      const links = [
        { id: 'ab', source: 'a', target: 'b', weight: 5 },
        { id: 'bc', source: 'b', target: 'c', weight: 5 },
      ];
      await writeFile(join(folder, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes: [plain('a', 'alpha'), plain('b', 'beta'), plain('c', 'gamma')], links }));
      const { app, page } = await launchOpened(join(dir, 'userData'), folder);
      const linkIds = async () => JSON.parse(await readFile(join(folder, 'workspace.json'), 'utf8')).links.map((link: { id: string }) => link.id);
      const unlinked = page.getByTestId('unlinked-nodes').getByTestId('node-entry-text');
      /** The middle of the link's line, in the window. */
      const middle = (id: string) =>
        page.locator(`[data-testid=link][data-link-id=${id}] [data-testid=link-line]`).evaluate((path: SVGPathElement) => {
          const point = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
          return { x: point.x, y: point.y };
        });
      try {
        await expect(page.getByTestId('link')).toHaveCount(2);

        // The popup: only "Delete". Clicking off cancels; Delete deletes the link, leaving alpha without one.
        let point = await middle('ab');
        await page.mouse.click(point.x, point.y, { button: 'right' });
        const menu = page.getByTestId('link-menu');
        await expect(menu.getByRole('menuitem')).toHaveText(['Delete']);
        await page.mouse.click(5, 5);
        await expect(menu).toHaveCount(0);
        expect(await linkIds()).toEqual(['ab', 'bc']);
        point = await middle('ab');
        await page.mouse.click(point.x, point.y, { button: 'right' });
        await page.getByTestId('link-menu-delete').click();
        await expect(menu).toHaveCount(0);
        await expect.poll(linkIds).toEqual(['bc']);
        await expect(unlinked).toHaveText(['alpha']);
        await expect(page.getByTestId('node')).toHaveText(['beta', 'gamma']);

        // The link dialog (double-clicking the link): Delete deletes it.
        point = await middle('bc');
        await page.mouse.dblclick(point.x, point.y);
        await page.getByTestId('weight-dialog').getByTestId('weight-delete').click();
        await expect(page.getByTestId('weight-dialog')).toHaveCount(0);
        await expect.poll(linkIds).toEqual([]);
        await expect(unlinked).toHaveText(['alpha', 'beta', 'gamma']);
        await expect(page.getByTestId('node')).toHaveCount(0);

        // The dialog that opens on creating a link: Delete deletes the new link.
        await entry(page, 'alpha').click({ button: 'right' });
        await page.getByTestId('node-menu-link').hover();
        await page.locator('[data-testid=node-menu-item][data-node-id=b]').click();
        await expect.poll(async () => (await linkIds()).length).toBe(1);
        await page.getByTestId('weight-dialog').getByTestId('weight-delete').click();
        await expect.poll(linkIds).toEqual([]);
        await expect(unlinked).toHaveText(['alpha', 'beta', 'gamma']);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('Import opens a dialog that creates nodes (each with a unique title) and links (whose ends are ids or titles) from the arrays under the nodes and links keys, skipping objects it cannot use and keys the file does not have', async () => {
    await withTemp(async (dir) => {
      const workspace = join(dir, 'ws');
      await mkdir(workspace);
      // The workspace already holds one node, which imported links can join.
      await writeFile(join(workspace, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes: [plain('w', 'existing')], links: [] }));
      await mkdir(join(dir, 'source'));
      const source = join(dir, 'source', 'graph.json');
      await writeFile(
        source,
        JSON.stringify({
          items: [
            { id: 'a', title: 'Alpha', description: 'first' },
            { id: 'b', description: 'only described' },
            { id: 3, body: 'only a body' },
            { id: 'd', colour: 'red' }, // no text: titled "Node"
            { title: '' }, // titled "Node2"
            { filename: 'notes.txt' },
            { description: 'a description longer than twenty-five characters' },
            { title: 'existing' }, // a workspace node's title: "existing2"
            'not an object',
          ],
          connections: [
            { source: 'a', target: 'b', weight: 8, description: 'a to b' },
            { source: 'b', target: 3 }, // no weight: that of a new link
            { source: 3, target: 'w', weight: 42 }, // to a node already in the workspace; a weight out of range is that of a new link
            { source: 'a', target: 'd' },
            { source: 'Alpha', target: 'notes.txt' }, // by titles
            { source: 'existing', target: 'Node2' }, // a title in the file is the file's node, before the workspace's
            { source: 'w', target: 'existing2' },
            { source: 'a description longer than', target: 'a' },
            { source: 'b', target: 'a' }, // the two nodes are already linked
            { source: 'Alpha', target: 'a' }, // the same node at both ends
            { source: 'a', target: 'nowhere' },
            { source: 'a' },
            'not an object',
          ],
        }),
      );
      const notAnObject = join(dir, 'source', 'list.json');
      await writeFile(notAnObject, JSON.stringify([{ title: 'x' }]));
      // The file dialog is answered with the JSON file twice, then with a file that is not a JSON object.
      const { app, page } = await launchOpened(join(dir, 'userData'), workspace, [source, source, notAnObject]);
      const info = async () => JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8'));
      const dialog = page.getByTestId('import-dialog');
      const chooseFile = async (name: string) => {
        await page.getByTestId('import').click();
        await expect(dialog).toBeVisible();
        await expect(dialog.getByTestId('import-submit')).toBeDisabled();
        await dialog.getByTestId('import-file').click();
        await expect(dialog.getByTestId('import-path')).toHaveText(name);
        await expect(dialog.getByTestId('import-submit')).toBeEnabled();
      };
      try {
        // The default keys ("nodes" and "edges") are not in the file: they are skipped without a word, and nothing is created.
        await chooseFile('graph.json');
        await expect(dialog.getByTestId('import-nodes')).toHaveAttribute('placeholder', 'nodes');
        await expect(dialog.getByTestId('import-links')).toHaveAttribute('placeholder', 'edges');
        await dialog.getByTestId('import-submit').click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByTestId('error')).toHaveCount(0);
        expect((await info()).nodes).toHaveLength(1);

        // The right keys: a node for each object, each showing its first field with text (its title if it has none) and
        // with a unique title (made from its text if it has none), and a link for each object whose ends are both found
        // and not yet linked.
        await chooseFile('graph.json');
        await dialog.getByTestId('import-nodes').fill('items');
        await dialog.getByTestId('import-links').fill('connections');
        await dialog.getByTestId('import-submit').click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByTestId('node-entry-text')).toHaveText([
          'existing',
          'Alpha',
          'only described',
          'only a body',
          'Node',
          'Node2',
          'notes.txt',
          'a description longer than twenty-five characters',
          'existing2',
        ]);
        const { nodes, links } = await info();
        expect(nodes).toMatchObject([
          { id: 'w' },
          { title: 'Alpha', description: 'first', body: null, display: ['title'] },
          { title: 'only described', description: 'only described', body: null, display: ['description'] },
          { title: 'only a body', description: null, body: 'only a body', display: ['body'] },
          { title: 'Node', description: null, body: null, display: ['title'] },
          { title: 'Node2', description: null, body: null, display: ['title'] },
          { title: 'notes.txt', description: null, body: null, display: ['title'] },
          { title: 'a description longer than', description: 'a description longer than twenty-five characters', display: ['description'] },
          { title: 'existing2', display: ['title'] },
        ]);
        const [, alpha, beta, three, d, node2, notes, long, existing2] = nodes.map((node: { id: string }) => node.id);
        const linked = (source: string, target: string, weight = 5, description: string | null = null) => ({ id: expect.any(String), source, target, weight, description });
        expect(links).toEqual([
          linked(alpha, beta, 8, 'a to b'),
          linked(beta, three),
          linked(three, 'w'),
          linked(alpha, d),
          linked(alpha, notes),
          linked(existing2, node2),
          linked('w', existing2),
          linked(long, alpha),
        ]);
        await expect(page.getByTestId('link')).toHaveCount(8);

        // A file that is not a JSON object cannot be imported: the reason is shown and the dialog stays open.
        await chooseFile('list.json');
        await dialog.getByTestId('import-submit').click();
        await expect(dialog.getByTestId('import-error')).toHaveText('list.json is not a JSON object');
        await expect(dialog).toBeVisible();

        // Cancel closes the dialog without importing.
        await dialog.getByTestId('import-cancel').click();
        await expect(dialog).toHaveCount(0);
        expect((await info()).nodes).toHaveLength(9);
      } finally {
        await app.close();
      }
    });
  });

  test('the node types button manages node types (a colour and properties); the node dialog chooses a node\'s type and its property values, and its display takes the colour', async () => {
    await withTemp(async (dir) => {
      const workspace = join(dir, 'ws');
      const { app, page } = await launchOpened(join(dir, 'userData'), workspace);
      const info = async () => JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8'));
      const manager = page.getByTestId('node-types-dialog');
      const editor = page.getByTestId('node-type-dialog');
      const entries = manager.getByTestId('node-type-entry');
      const background = (id: string) => page.getByTestId('workspace').locator(`[data-node-id="${id}"] [data-testid=node]`).evaluate((element) => getComputedStyle(element).backgroundColor);
      try {
        // Only the default type to begin with: it cannot be deleted.
        await page.getByTestId('node-types').click();
        await expect(manager).toBeVisible();
        await expect(entries.getByTestId('node-type-entry-name')).toHaveText(['Default']);
        await expect(entries.getByTestId('node-type-entry-count')).toHaveText(['0 nodes']);
        await expect(entries.getByTestId('node-type-delete')).toBeDisabled();

        // A new type: its name must be one no other type has, and each property a key no other property of it has.
        await manager.getByTestId('node-type-new').click();
        await expect(editor).toBeVisible();
        await expect(editor.getByTestId('node-type-submit')).toHaveText('Create');
        await expect(editor.getByTestId('node-type-submit')).toBeDisabled();
        await editor.getByTestId('node-type-name').fill('Default');
        await expect(editor.getByTestId('node-type-name-taken')).toBeVisible();
        await expect(editor.getByTestId('node-type-submit')).toBeDisabled();
        await editor.getByTestId('node-type-name').fill(' Person ');
        await expect(editor.getByTestId('node-type-submit')).toBeEnabled();
        await expect(editor.getByTestId('node-type-colour')).toHaveCount(8);
        await expect(editor.locator('[data-testid=node-type-colour][aria-checked=true]')).toHaveAttribute('aria-label', 'White');
        await editor.getByRole('radio', { name: 'Rose' }).click();
        const rows = editor.getByTestId('node-type-property');
        await editor.getByTestId('property-add').click();
        await expect(rows).toHaveCount(1);
        await expect(rows.getByTestId('property-key')).toBeFocused();
        await expect(editor.getByTestId('property-key-error')).toHaveText('A property needs a key.');
        await expect(editor.getByTestId('node-type-submit')).toBeDisabled();
        await rows.nth(0).getByTestId('property-key').fill('role');
        await rows.nth(0).getByTestId('property-value').fill('staff');
        await editor.getByTestId('property-add').click();
        await rows.nth(1).getByTestId('property-key').fill('role');
        await expect(editor.getByTestId('property-key-error')).toHaveText('Another property has this key.');
        await rows.nth(1).getByTestId('property-key').fill('active');
        await rows.nth(1).getByTestId('property-kind').selectOption('boolean');
        await rows.nth(1).getByTestId('property-value').check();
        await editor.getByTestId('property-add').click();
        await rows.nth(2).getByTestId('property-remove').click();
        await expect(rows).toHaveCount(2);
        await editor.getByTestId('node-type-submit').click();
        await expect(editor).toHaveCount(0);
        await expect(entries.getByTestId('node-type-entry-name')).toHaveText(['Default', 'Person']);
        const [, person] = (await info()).nodeTypes;
        expect(person).toEqual({
          id: expect.any(String),
          name: 'Person',
          colour: '#fde2e4',
          properties: [
            { id: expect.any(String), key: 'role', kind: 'text', value: 'staff' },
            { id: expect.any(String), key: 'active', kind: 'boolean', value: true },
          ],
        });
        const [role, active] = person.properties.map((property: { id: string }) => property.id);
        await manager.getByTestId('node-types-close').click();
        await expect(manager).toHaveCount(0);

        // A new node is of the default type; choosing another shows its properties, filled in with its values.
        await page.getByTestId('add').click();
        const dialog = page.getByTestId('node-dialog');
        await expect(dialog.getByTestId('node-type').locator('option')).toHaveText(['Default', 'Person']);
        await expect(dialog.getByTestId('node-type')).toHaveValue('default');
        await expect(dialog.getByTestId('node-property')).toHaveCount(0);
        await dialog.getByTestId('node-type').selectOption({ label: 'Person' });
        await expect(dialog.locator('[data-testid=node-property][data-key=role]')).toHaveValue('staff');
        await expect(dialog.locator('[data-testid=node-property][data-key=active]')).toBeChecked();
        await dialog.locator('[data-testid=node-property][data-key=role]').fill('manager');
        await dialog.getByTestId('node-title').fill('Ada');
        await dialog.getByTestId('node-submit').click();
        await expect(dialog).toHaveCount(0);
        await createNode(page, { title: 'Bob' });
        await link(page, 'Ada', 'Bob');
        const [ada, bob] = (await info()).nodes;
        expect(ada).toMatchObject({ title: 'Ada', type: person.id, properties: { [role]: 'manager', [active]: true } });
        expect(bob).toMatchObject({ title: 'Bob', type: 'default', properties: {} });
        // The display takes the colour of the node's type.
        await expect.poll(() => background(ada.id)).toBe('rgb(253, 226, 228)');
        await expect.poll(() => background(bob.id)).toBe('rgb(255, 255, 255)');
        // The node list shows the type and the property values.
        await entry(page, 'Ada').click();
        await expect(entry(page, 'Ada').getByTestId('node-entry-property').locator('dt')).toHaveText(['Title', 'Description', 'Body', 'Type', 'role', 'active']);
        await expect(entry(page, 'Ada').getByTestId('node-entry-property').locator('dd').nth(3)).toHaveText('Person');
        await expect(entry(page, 'Ada').getByTestId('node-entry-property').locator('dd').nth(4)).toHaveText('manager');
        await expect(entry(page, 'Ada').getByTestId('node-entry-property').locator('dd').nth(5)).toHaveText('True');
        await entry(page, 'Ada').click();

        // Editing the node, its values are filled in.
        await entry(page, 'Ada').dblclick();
        await expect(dialog.getByTestId('node-type')).toHaveValue(person.id);
        await expect(dialog.locator('[data-testid=node-property][data-key=role]')).toHaveValue('manager');
        await page.keyboard.press('Escape');

        // Editing the type: a property removed goes from its nodes, one added takes its default value, and the colour changes.
        await page.getByTestId('node-types').click();
        await expect(entries.getByTestId('node-type-entry-count')).toHaveText(['1 node', '1 node']);
        await entries.nth(1).getByTestId('node-type-edit').click();
        await expect(editor.getByTestId('node-type-name')).toHaveValue('Person');
        await expect(editor.getByTestId('node-type-submit')).toHaveText('Save');
        await rows.nth(0).getByTestId('property-remove').click();
        await editor.getByTestId('property-add').click();
        await rows.nth(1).getByTestId('property-key').fill('team');
        await editor.getByRole('radio', { name: 'Sky' }).click();
        await editor.getByTestId('node-type-submit').click();
        await expect(editor).toHaveCount(0);
        const edited = (await info()).nodeTypes[1];
        expect(edited).toMatchObject({ id: person.id, colour: '#dbeafe', properties: [{ id: active, key: 'active' }, { key: 'team', kind: 'text', value: '' }] });
        expect((await info()).nodes[0].properties).toEqual({ [active]: true, [edited.properties[1].id]: '' });
        await expect.poll(() => background(ada.id)).toBe('rgb(219, 234, 254)');

        // Deleting a type with nodes asks first; cancelling keeps it. Deleting it makes its nodes nodes of the default type.
        await entries.nth(1).getByTestId('node-type-delete').click();
        const confirm = page.getByTestId('node-type-delete-dialog');
        await expect(confirm).toContainText('Its node becomes a node of the type “Default”.');
        await confirm.getByTestId('node-type-delete-cancel').click();
        await expect(entries).toHaveCount(2);
        await entries.nth(1).getByTestId('node-type-delete').click();
        await confirm.getByTestId('node-type-delete-confirm').click();
        await expect(entries.getByTestId('node-type-entry-name')).toHaveText(['Default']);
        await expect(entries.getByTestId('node-type-entry-count')).toHaveText(['2 nodes']);
        expect((await info()).nodes[0]).toMatchObject({ type: 'default', properties: {} });
        await page.keyboard.press('Escape');
        await expect(manager).toHaveCount(0);
        await expect.poll(() => background(ada.id)).toBe('rgb(255, 255, 255)');

        // The default type can be edited: its colour shows on every node of it.
        await page.getByTestId('node-types').click();
        await entries.nth(0).dblclick();
        await editor.getByRole('radio', { name: 'Mint' }).click();
        await editor.getByTestId('node-type-submit').click();
        await manager.getByTestId('node-types-close').click();
        await expect.poll(() => background(bob.id)).toBe('rgb(220, 245, 227)');
        expect((await info()).nodeTypes).toEqual([{ id: 'default', name: 'Default', colour: '#dcf5e3', properties: [] }]);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('opening a workspace gives each node without a title one made from its text, and a title an earlier node has an integer at its end', async () => {
    await withTemp(async (dir) => {
      const workspace = join(dir, 'ws');
      await mkdir(workspace);
      const untitled = (id: string, body: string) => ({ ...plain(id, ''), title: null, body, display: ['body'] });
      const nodes = [untitled('x', 'legacy   body text that is long'), plain('y', 'same'), plain('z', 'same'), untitled('v', 'same'), plain('u', 'same2')];
      await writeFile(join(workspace, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links: [] }));
      const { app, page } = await launchOpened(join(dir, 'userData'), workspace);
      try {
        await expect(page.getByTestId('node-entry')).toHaveCount(5);
        // A title given in the file is kept before any made or numbered; the nodes are written back with their titles.
        const titles = async () => JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8')).nodes.map((node: { title: string }) => node.title);
        expect(await titles()).toEqual(['legacy body text that is', 'same', 'same3', 'same4', 'same2']);

        // Editing a node, its own title can be kept, but not changed to another node's.
        await entry(page, 'same3').dblclick();
        const dialog = page.getByTestId('node-dialog');
        await expect(dialog.getByTestId('node-submit')).toBeEnabled();
        await dialog.getByTestId('node-title').fill('same');
        await expect(dialog.getByTestId('node-title-taken')).toBeVisible();
        await expect(dialog.getByTestId('node-submit')).toBeDisabled();
        await dialog.getByTestId('node-title').fill('renamed');
        await dialog.getByTestId('node-submit').click();
        await expect(dialog).toHaveCount(0);
        expect(await titles()).toEqual(['legacy body text that is', 'same', 'renamed', 'same4', 'same2']);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('the link list (right) shows each link as "source - target"; clicking an entry shows its data, right-clicking deletes it, double-clicking opens the link dialog', async () => {
    await withTemp(async (dir) => {
      const folder = join(dir, 'ws');
      await mkdir(folder);
      const links = [
        { id: 'ab', source: 'a', target: 'b', weight: 5, description: 'alpha leads to beta' },
        { id: 'bc', source: 'b', target: 'c', weight: 3 },
        { id: 'cd', source: 'c', target: 'd', weight: 7 },
      ];
      const nodes = [plain('a', 'alpha'), plain('b', 'beta'), plain('c', 'gamma'), plain('d', 'delta')];
      await writeFile(join(folder, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links }));
      const { app, page } = await launchOpened(join(dir, 'userData'), folder);
      const saved = async () => JSON.parse(await readFile(join(folder, 'workspace.json'), 'utf8')).links;
      const list = page.getByTestId('link-list');
      const texts = list.getByTestId('link-entry-text');
      const linkEntry = (id: string) => list.locator(`[data-testid=link-entry][data-link-id=${id}]`);
      try {
        // One part only, with a search box; the list is at the right of the canvas.
        await expect(texts).toHaveText(['alpha - beta', 'beta - gamma', 'gamma - delta']);
        await expect(list.locator('[role=separator]')).toHaveCount(0);
        expect((await list.boundingBox())!.x).toBeGreaterThan((await page.getByTestId('workspace').boundingBox())!.x);
        await list.getByTestId('link-search').fill('GAMMA');
        await expect(texts).toHaveText(['beta - gamma', 'gamma - delta']);
        await list.getByTestId('link-search').fill('');

        // Clicking an entry shows the link's data, each labelled (no description as a dash); clicking it again hides it.
        const ab = linkEntry('ab');
        await expect(ab.getByTestId('link-entry-properties')).toHaveCount(0);
        await ab.click();
        await expect(ab).toHaveAttribute('data-expanded', 'true');
        await expect(ab.getByTestId('link-entry-property').locator('dt')).toHaveText(['Source', 'Target', 'Weight', 'Description']);
        await expect(ab.getByTestId('link-entry-property').locator('dd')).toHaveText(['alpha', 'beta', '5', 'alpha leads to beta']);
        await linkEntry('bc').click();
        await expect(linkEntry('bc').locator('[data-property=description] dd')).toHaveText('—');
        await linkEntry('bc').click();
        await ab.click();
        await expect(ab.getByTestId('link-entry-properties')).toHaveCount(0);

        // Double-clicking opens the link dialog (and leaves the entry collapsed); Save sets the weight and description.
        await linkEntry('bc').dblclick();
        const dialog = page.getByTestId('weight-dialog');
        await expect(dialog).toBeVisible();
        await expect(linkEntry('bc')).toHaveAttribute('data-expanded', 'false');
        await expect(dialog.getByTestId('weight-value')).toHaveText('3');
        await dialog.getByTestId('link-description').fill('beta to gamma');
        await dialog.getByTestId('weight-save').click();
        await expect(dialog).toHaveCount(0);
        await expect.poll(async () => (await saved())[1]).toMatchObject({ id: 'bc', description: 'beta to gamma' });

        // Right-clicking opens the link popup: only Delete (no way to create a link), which deletes the link.
        await linkEntry('ab').click({ button: 'right' });
        const menu = page.getByTestId('link-menu');
        await expect(menu.getByRole('menuitem')).toHaveText(['Delete']);
        await page.getByTestId('link-menu-delete').click();
        await expect.poll(async () => (await saved()).map((link: { id: string }) => link.id)).toEqual(['bc', 'cd']);
        await expect(texts).toHaveText(['beta - gamma', 'gamma - delta']);
        await expect(page.getByTestId('unlinked-nodes').getByTestId('node-entry-text')).toHaveText(['alpha']);

        // Delete in the link dialog deletes it too.
        await linkEntry('cd').dblclick();
        await dialog.getByTestId('weight-delete').click();
        await expect(texts).toHaveText(['beta - gamma']);
        await expect(page.getByTestId('link')).toHaveCount(1);

        // The list follows node titles, and links created elsewhere.
        await entry(page, 'beta').dblclick();
        await page.getByTestId('node-dialog').getByTestId('node-title').fill('BETA');
        await page.getByTestId('node-dialog').getByTestId('node-submit').click();
        await expect(texts).toHaveText(['BETA - gamma']);
        await link(page, 'alpha', 'delta');
        await expect(texts).toHaveText(['BETA - gamma', 'alpha - delta']);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('"Link to..." in the node dialog lists by title the other nodes the node is not linked to; the one chosen is linked to on Create or Save', async () => {
    await withTemp(async (dir) => {
      const folder = join(dir, 'ws');
      await mkdir(folder);
      const nodes = [plain('a', 'alpha'), plain('b', 'beta'), plain('c', 'gamma')];
      await writeFile(join(folder, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links: [{ id: 'ab', source: 'a', target: 'b', weight: 5 }] }));
      const { app, page } = await launchOpened(join(dir, 'userData'), folder);
      const saved = async () => JSON.parse(await readFile(join(folder, 'workspace.json'), 'utf8'));
      const ends = async () => (await saved()).links.map((link: { source: string; target: string }) => [link.source, link.target]);
      const dialog = page.getByTestId('node-dialog');
      const linkTo = dialog.getByTestId('node-link-to');
      try {
        // A new node: every node is listed, those without a link first; none is chosen to begin with.
        await page.getByTestId('add').click();
        await expect(linkTo.locator('option')).toHaveText(['None', 'gamma', 'alpha', 'beta']);
        await expect(linkTo).toHaveValue('');
        // It is under the File button.
        expect((await linkTo.boundingBox())!.y).toBeGreaterThan((await dialog.getByTestId('node-file').boundingBox())!.y);
        await dialog.getByTestId('node-title').fill('delta');
        await linkTo.selectOption({ label: 'beta' });
        await dialog.getByTestId('node-submit').click();
        await closeLinkDialog(page); // the new link's dialog opens, as for any new link
        const delta = (await saved()).nodes.find((node: { title: string }) => node.title === 'delta').id;
        expect(await ends()).toEqual([['a', 'b'], [delta, 'b']]);

        // Editing a node: neither the node itself nor the nodes it is linked to (either way) are listed.
        await entry(page, 'alpha').dblclick();
        await expect(linkTo.locator('option')).toHaveText(['None', 'gamma', 'delta']);
        await linkTo.selectOption({ label: 'gamma' });
        await dialog.getByTestId('node-submit').click();
        await closeLinkDialog(page);
        expect(await ends()).toEqual([['a', 'b'], [delta, 'b'], ['a', 'c']]);

        // Saving with none chosen links nothing; cancelling links nothing.
        await entry(page, 'beta').dblclick();
        await expect(linkTo.locator('option')).toHaveText(['None', 'gamma']);
        await dialog.getByTestId('node-submit').click();
        await expect(dialog).toHaveCount(0);
        await entry(page, 'beta').dblclick();
        await linkTo.selectOption({ label: 'gamma' });
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(page.getByTestId('weight-dialog')).toHaveCount(0);
        expect(await ends()).toEqual([['a', 'b'], [delta, 'b'], ['a', 'c']]);

        // A node linked to every other node has none to link to: the list is disabled.
        await entry(page, 'alpha').dblclick();
        await linkTo.selectOption({ label: 'delta' });
        await dialog.getByTestId('node-submit').click();
        await closeLinkDialog(page);
        await entry(page, 'alpha').dblclick();
        await expect(linkTo).toBeDisabled();
        await expect(linkTo.locator('option')).toHaveText(['No nodes to link to']);
        await page.keyboard.press('Escape');
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('double-clicking a link opens the link dialog with its weight and description; Save sets both, Cancel changes nothing, and an empty description is stored as null', async () => {
    await withTemp(async (dir) => {
      const folder = join(dir, 'ws');
      await mkdir(folder);
      // A link written before links had descriptions.
      await writeFile(join(folder, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes: [plain('a', 'alpha'), plain('b', 'beta')], links: [{ id: 'ab', source: 'a', target: 'b', weight: 10 }] }));
      const userData = join(dir, 'userData');
      const links = async () => JSON.parse(await readFile(join(folder, 'workspace.json'), 'utf8')).links;
      const dialog = (page: Page) => page.getByTestId('weight-dialog');
      /** Double-clicks the middle of the link's line. */
      const openLink = async (page: Page) => {
        const point = await page.locator('[data-testid=link][data-link-id=ab] [data-testid=link-line]').evaluate((path: SVGPathElement) => {
          const middle = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
          return { x: middle.x, y: middle.y };
        });
        await page.mouse.dblclick(point.x, point.y);
        await expect(dialog(page)).toBeVisible();
      };

      const first = await launchOpened(userData, folder);
      const { page } = first;
      try {
        // The link has no description yet: the text area is empty, under its label.
        await openLink(page);
        const description = dialog(page).getByLabel('Description');
        await expect(description).toHaveValue('');
        await expect(dialog(page).getByTestId('weight-value')).toHaveText('10');

        // Save stores the description with the weight.
        await description.fill('alpha leads to beta');
        await dialog(page).getByTestId('weight-save').click();
        await expect(dialog(page)).toHaveCount(0);
        await expect.poll(links).toEqual([{ id: 'ab', source: 'a', target: 'b', weight: 10, description: 'alpha leads to beta' }]);

        // Reopened, the dialog shows it; Cancel leaves it as it was.
        await openLink(page);
        await expect(description).toHaveValue('alpha leads to beta');
        await description.fill('something else');
        await dialog(page).getByTestId('weight-cancel').click();
        await expect(dialog(page)).toHaveCount(0);
        expect((await links())[0].description).toBe('alpha leads to beta');
      } finally {
        await first.app.close().catch(() => undefined);
      }

      // The description comes back when the workspace is reopened; emptied and saved, it is stored as null.
      const second = await launch(userData, join(dir, 'never-picked'));
      try {
        await openLink(second.page);
        const description = dialog(second.page).getByLabel('Description');
        await expect(description).toHaveValue('alpha leads to beta');
        await description.fill('');
        await dialog(second.page).getByTestId('weight-save').click();
        await expect.poll(links).toEqual([{ id: 'ab', source: 'a', target: 'b', weight: 10, description: null }]);
      } finally {
        await second.app.close().catch(() => undefined);
      }
    });
  });

  test('the toolbar button lays the network out from scratch, ignoring the positions it would otherwise start from, and saves the result', async () => {
    await withTemp(async (dir) => {
      // The same network twice: one workspace has saved positions (a tall column, from some earlier layout), the other none.
      const ids = ['hub', 'a', 'b', 'c', 'd', 'e'];
      const nodes = ids.map((id) => plain(id, id));
      const links = ids.slice(1).map((id, i) => ({ id: `link-${id}`, source: i % 2 ? 'hub' : ids[i], target: id, weight: 5 }));
      const column = Object.fromEntries(ids.map((id, i) => [id, { x: 0, y: i * 400 }]));
      const [withSaved, without] = [join(dir, 'with-saved'), join(dir, 'without')];
      for (const folder of [withSaved, without]) await mkdir(folder);
      await writeFile(join(withSaved, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links, layout: { network: 'from-an-earlier-layout', positions: column, satisfied: true } }));
      await writeFile(join(without, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links }));
      const positions = async (folder: string) => JSON.parse(await readFile(join(folder, 'workspace.json'), 'utf8')).layout?.positions as Record<string, { x: number; y: number }> | undefined;
      const laidOut = async (folder: string, userData: string) => {
        const { app, page } = await launchOpened(join(dir, userData), folder);
        await expect(page.getByTestId('link')).toHaveCount(links.length);
        await expect(page.getByTestId('layout-wait')).toHaveCount(0);
        return { app, page };
      };

      // From scratch: the layout of the workspace with no saved positions.
      const first = await laidOut(without, 'userData-1');
      await expect.poll(async () => Object.keys((await positions(without)) ?? {}).length).toBe(ids.length);
      const scratch = (await positions(without))!;
      await first.app.close();

      // Opened, the other workspace is laid out starting from its saved column, so it differs from that.
      const { app, page } = await laidOut(withSaved, 'userData-2');
      try {
        await expect.poll(async () => (await positions(withSaved))?.hub).not.toEqual(column.hub);
        const carried = (await positions(withSaved))!;
        expect(carried).not.toEqual(scratch);

        // The button: the layout runs again with no starting positions (the spinner shows meanwhile), gives the layout
        // from scratch, and saves it.
        const relayout = page.getByTestId('relayout');
        await expect(relayout).toHaveAttribute('title', 'Lay out the network from scratch');
        await relayout.click();
        await expect(page.getByTestId('layout-wait')).toHaveCount(0);
        await expect.poll(async () => positions(withSaved)).toEqual(scratch);
        await expect(page.getByTestId('network')).toHaveAttribute('data-layout', 'run');
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('deleting or adding a link lays the network out from scratch, ignoring the positions it would otherwise start from', async () => {
    await withTemp(async (dir) => {
      // The network with and without an extra link (a to c), laid out from scratch; and the network with it, with saved
      // positions (a tall column) that a layout starting from them would carry along.
      const ids = ['hub', 'a', 'b', 'c', 'd', 'e'];
      const nodes = ids.map((id) => plain(id, id));
      const links = ids.slice(1).map((id, i) => ({ id: `link-${id}`, source: i % 2 ? 'hub' : ids[i], target: id, weight: 5 }));
      const extra = { id: 'extra', source: 'a', target: 'c', weight: 5 };
      const column = Object.fromEntries(ids.map((id, i) => [id, { x: 0, y: i * 400 }]));
      const [withSaved, withExtra, withoutExtra] = [join(dir, 'with-saved'), join(dir, 'with-extra'), join(dir, 'without-extra')];
      for (const folder of [withSaved, withExtra, withoutExtra]) await mkdir(folder);
      await writeFile(join(withSaved, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links: [...links, extra], layout: { network: 'from-an-earlier-layout', positions: column, satisfied: true } }));
      await writeFile(join(withExtra, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links: [...links, extra] }));
      await writeFile(join(withoutExtra, 'workspace.json'), JSON.stringify({ appId: 'terrane', nodes, links }));
      const positions = async (folder: string) => JSON.parse(await readFile(join(folder, 'workspace.json'), 'utf8')).layout?.positions as Record<string, { x: number; y: number }> | undefined;
      const scratch = async (folder: string, userData: string) => {
        const { app } = await launchOpened(join(dir, userData), folder);
        await expect.poll(async () => Object.keys((await positions(folder)) ?? {}).length).toBe(ids.length);
        const laidOut = (await positions(folder))!;
        await app.close();
        return laidOut;
      };
      const [scratchWith, scratchWithout] = [await scratch(withExtra, 'userData-1'), await scratch(withoutExtra, 'userData-2')];
      expect(scratchWith).not.toEqual(scratchWithout);

      const { app, page } = await launchOpened(join(dir, 'userData-3'), withSaved);
      try {
        // Opened: laid out starting from the saved column, so not as from scratch.
        await expect.poll(async () => (await positions(withSaved))?.hub).not.toEqual(column.hub);
        await expect(page.getByTestId('layout-wait')).toHaveCount(0);
        expect(await positions(withSaved)).not.toEqual(scratchWith);

        // Deleting the extra link: as the network without it, from scratch.
        const point = await page.locator('[data-testid=link][data-link-id=extra] [data-testid=link-line]').evaluate((path: SVGPathElement) => {
          const middle = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
          return { x: middle.x, y: middle.y };
        });
        await page.mouse.click(point.x, point.y, { button: 'right' });
        await page.getByTestId('link-menu-delete').click();
        await expect.poll(async () => positions(withSaved)).toEqual(scratchWithout);

        // Adding it again: as the network with it, from scratch.
        await entry(page, 'a').click({ button: 'right' });
        await page.getByTestId('node-menu-link').hover();
        await page.locator('[data-testid=node-menu-item][data-node-id=c]').click();
        await closeLinkDialog(page);
        await expect.poll(async () => positions(withSaved)).toEqual(scratchWith);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('the layout is saved in workspace.json and used as it is when the workspace is opened again, until the network changes', async () => {
    await withTemp(async (dir) => {
      const folder = join(dir, 'ws');
      await mkdir(folder);
      const nodes = ['a', 'b', 'c', 'd'].map((id) => plain(id, id));
      const links = [
        { id: 'ab', source: 'a', target: 'b', weight: 10 },
        { id: 'bc', source: 'b', target: 'c', weight: 5 },
        { id: 'cd', source: 'c', target: 'd', weight: 3 },
      ];
      await writeFile(join(folder, 'workspace.json'), JSON.stringify({ appId: 'terrane', title: 'mine', nodes, links }));
      const saved = async () => JSON.parse(await readFile(join(folder, 'workspace.json'), 'utf8'));
      const userData = join(dir, 'userData');

      // First opened: the layout runs, and is saved with a position for every node; the file's other entries are kept.
      let { app, page } = await launchOpened(userData, folder);
      await expect(page.getByTestId('network')).toHaveAttribute('data-layout', 'run');
      await expect.poll(async () => Object.keys((await saved()).layout?.positions ?? {}).sort()).toEqual(['a', 'b', 'c', 'd']);
      const first = await saved();
      expect(first.title).toBe('mine');
      expect(first.layout).toMatchObject({ network: expect.any(String), satisfied: true });
      const shown = async () => page.getByTestId('workspace').locator('[data-node-id]').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
      const before = await shown();
      await app.close();

      // Opened again: the saved layout is used as it is (the layout does not run), and shows the same.
      ({ app, page } = await launchOpened(userData, folder));
      try {
        await expect(page.getByTestId('network')).toHaveAttribute('data-layout', 'saved');
        // The same, but for the rounding of the saved positions (to hundredths).
        const after = await shown();
        expect(after).toHaveLength(before.length);
        after.forEach((box, i) => {
          expect(Math.abs(box.x - before[i].x)).toBeLessThan(0.5);
          expect(Math.abs(box.y - before[i].y)).toBeLessThan(0.5);
        });
      } finally {
        await app.close().catch(() => undefined);
      }
      expect((await saved()).layout).toEqual(first.layout);

      // Changed while closed: the saved layout is for another network, so the layout runs (from the saved positions) and is saved again.
      await writeFile(join(folder, 'workspace.json'), JSON.stringify({ ...first, links: [...links, { id: 'da', source: 'd', target: 'a', weight: 8 }] }));
      ({ app, page } = await launchOpened(userData, folder));
      try {
        await expect(page.getByTestId('network')).toHaveAttribute('data-layout', 'run');
        await expect.poll(async () => (await saved()).layout.network).not.toBe(first.layout.network);
      } finally {
        await app.close().catch(() => undefined);
      }
    });
  });

  test('an existing workspace.json without nodes gets an empty nodes array, and its other entries are kept', async () => {
    await withTemp(async (dir) => {
      const folder = join(dir, 'old');
      await mkdir(folder);
      await writeFile(join(folder, 'workspace.json'), JSON.stringify({ title: 'mine' }));
      const { app, page } = await launchOpened(join(dir, 'userData'), folder);
      await expect(page.getByTestId('workspace')).toBeVisible();
      expect(JSON.parse(await readFile(join(folder, 'workspace.json'), 'utf8'))).toEqual({ title: 'mine', nodes: [] });
      await app.close();
    });
  });

  test('a second app instance cannot open a workspace that is already open, and shows nothing for it', async () => {
    await withTemp(async (dir) => {
      const workspace = join(dir, 'shared');
      const first = await launchOpened(join(dir, 'userData-1'), workspace);
      await expect(first.page.getByTestId('workspace')).toBeVisible();

      const second = await launch(join(dir, 'userData-2'), workspace);
      await second.page.getByTestId('open-workspace').click();
      await expect(second.page.getByTestId('error')).toContainText('in use by another instance');
      await expect(second.page.getByTestId('workspace')).toHaveCount(0);
      expect(await second.page.evaluate(async () => (await (window as unknown as { workspaceBridge: { current: () => Promise<{ open: boolean }> } }).workspaceBridge.current()).open)).toBe(false);

      await first.app.close();
      await second.app.close();
    });
  });

  test('a workspace that cannot be opened leaves the open one open, and the open one is what is reopened after a restart', async () => {
    await withTemp(async (dir) => {
      const shared = join(dir, 'shared');
      const mine = join(dir, 'mine');
      const userData = join(dir, 'userData-2');
      const holder = await launchOpened(join(dir, 'userData-1'), shared);

      type Bridge = { workspaceBridge: { current: () => Promise<{ open: boolean; name?: string }> } };
      const second = await launch(userData, [mine, shared].join(delimiter));
      await second.page.getByTestId('open-workspace').click();
      await expect(second.page.getByTestId('workspace')).toBeVisible();
      await second.page.getByTestId('open-workspace').click(); // the folder held by the first instance
      await expect(second.page.getByTestId('error')).toContainText('in use by another instance');
      expect(await second.page.evaluate(async () => (await (window as unknown as Bridge).workspaceBridge.current()))).toMatchObject({ open: true, name: 'mine' });
      await second.app.close();

      const third = await launch(userData, join(dir, 'never-picked'));
      await expect(third.page.getByTestId('workspace')).toBeVisible();
      expect(await third.page.evaluate(async () => (await (window as unknown as Bridge).workspaceBridge.current()).name)).toBe('mine');
      await third.app.close();
      await holder.app.close();
    });
  });

  test('the app makes no network request: everything it loads comes from the app itself', async () => {
    await withTemp(async (dir) => {
      const { app, page, requests } = await launch(join(dir, 'userData'));
      await expect(page.getByTestId('toolbar')).toBeVisible();
      expect(requests.length).toBeGreaterThan(0);
      for (const url of requests) expect(url, url).toMatch(/^(app|data|blob):/);
      await app.close();
    });
  });
});

test.describe('electron shell: security', () => {
  test('the renderer has no Node, no Electron and only the declared bridge', async () => {
    await withTemp(async (dir) => {
      const { app, page } = await launch(join(dir, 'userData'));
      const exposed = await page.evaluate(() => ({
        require: typeof (globalThis as Record<string, unknown>).require,
        process: typeof (globalThis as Record<string, unknown>).process,
        buffer: typeof (globalThis as Record<string, unknown>).Buffer,
        electron: typeof (globalThis as Record<string, unknown>).electron,
        groups: Object.keys((window as unknown as { abBridge: object }).abBridge).sort(),
        workspaceBridge: Object.keys((window as unknown as { workspaceBridge: object }).workspaceBridge).sort(),
        isolated: (window as unknown as { abBridge: { app: Record<string, unknown> } }).abBridge.app.info !== undefined,
        protocol: location.protocol,
      }));
      expect(exposed).toMatchObject({ require: 'undefined', process: 'undefined', buffer: 'undefined', electron: 'undefined', isolated: true, protocol: 'app:' });
      expect(exposed.workspaceBridge).toEqual(['createLink', 'createNode', 'createNodeType', 'current', 'deleteLink', 'deleteNode', 'deleteNodeType', 'importFile', 'pickFile', 'pickImportFile', 'readNode', 'saveLayout', 'updateLink', 'updateNode', 'updateNodeType']);
      expect(exposed.groups).toEqual(['app', 'credentials', 'data', 'net', 'sidecar', 'workspace']);
      await app.close();
    });
  });

  test('window.open and navigation away from the app are blocked', async () => {
    await withTemp(async (dir) => {
      const { app, page } = await launch(join(dir, 'userData'));
      const before = app.windows().length;
      const opened = await page.evaluate(() => window.open('https://example.com') === null);
      expect(opened).toBe(true);
      await page.evaluate(() => { location.href = 'https://example.com/'; });
      await page.waitForTimeout(500);
      expect(page.url()).toMatch(/^app:\/\//);
      expect(app.windows().length).toBe(before);
      await app.close();
    });
  });

  test('the CSP stops the renderer reaching any remote origin', async () => {
    await withTemp(async (dir) => {
      const { app, page } = await launch(join(dir, 'userData'));
      const outcome = await page.evaluate(async () => {
        try {
          await fetch('https://example.com/');
          return 'fetched';
        } catch {
          return 'blocked';
        }
      });
      expect(outcome).toBe('blocked');
      const csp = await page.evaluate(async () => (await fetch(location.href)).headers.get('content-security-policy'));
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("object-src 'none'");
      await app.close();
    });
  });

  test('bad requests over the bridge come back as coded errors, and the bridge cannot reach an unknown channel', async () => {
    await withTemp(async (dir) => {
      const { app, page } = await launch(join(dir, 'userData'));
      await expect(page.getByTestId('toolbar')).toBeVisible();
      const results = await page.evaluate(async () => {
        const bridge = (window as unknown as { abBridge: Record<string, Record<string, (input?: unknown) => Promise<{ ok: boolean; error?: { code: string } }>>> }).abBridge;
        return {
          badShape: (await bridge.credentials.status({ service: 5 })).error?.code,
          unknownMethod: typeof (bridge.credentials as Record<string, unknown>).drop,
          unknownGroup: typeof (bridge as Record<string, unknown>).fs,
          noGenericInvoke: typeof (bridge as Record<string, unknown>).invoke,
        };
      });
      expect(results).toEqual({ badShape: 'invalid_request', unknownMethod: 'undefined', unknownGroup: 'undefined', noGenericInvoke: 'undefined' });
      await app.close();
    });
  });
});
