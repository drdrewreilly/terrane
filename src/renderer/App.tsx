import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ab } from './ab';
import { Canvas } from './Canvas';
import { ImportDialog } from './ImportDialog';
import { LinkDialog, linkChanged } from './LinkDialog';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';
import { NodeDialog } from './NodeDialog';
import { NodeList } from './NodeList';
import { NodeMenu } from './NodeMenu';
import { SplitView } from './SplitView';
import { Toolbar } from './Toolbar';

/**
 * A toolbar (new workspace, open workspace, add, import) above the node list (left) and the canvas, which shows the network of
 * the nodes that have a link (right), split by a draggable splitter. Right-clicking a node in either opens the node popup. Workspaces are created and opened
 * the framework's way (`ab.workspace`); the main process reopens the last one at startup.
 */
export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>();
  /**
   * Counts the workspaces opened: the canvas is made afresh for each (and so first shows its network zoomed right out).
   * An open that leaves the same workspace showing (cancelled, or failed) does not count.
   */
  const [opened, setOpened] = useState(0);
  /** The workspace being shown, as JSON: kept up to date however it changes (an open, or a change to the network). */
  const shown = useRef<string>(undefined);
  useEffect(() => {
    shown.current = JSON.stringify(workspace && { ...workspace, layout: undefined });
  }, [workspace]);
  const [error, setError] = useState<string>();
  /** The node dialog being shown: for a new node, or for editing `node`. */
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'edit'; node: NodeRecord }>();
  /** Whether the import dialog is open. */
  const [importing, setImporting] = useState(false);
  /** The location the "new workspace" dialog starts with; `null` while the dialog is closed. */
  const [newWorkspaceLocation, setNewWorkspaceLocation] = useState<string | null>(null);

  /** The node popup being shown: for the node right-clicked (`source`), at (`x`, `y`) in the window. */
  const [menu, setMenu] = useState<{ source: string; x: number; y: number }>();
  /** The node highlighted on the canvas: the one the pointer is over in the node popup. */
  const [highlighted, setHighlighted] = useState<string>();
  /** The link just created, whose link dialog is open. */
  const [weighing, setWeighing] = useState<WorkspaceLink>();
  /** The ids of the nodes that have at least one link. */
  const linked = useMemo(() => new Set(workspace?.links.flatMap((link) => [link.source, link.target]) ?? []), [workspace]);
  /** The nodes shown on the canvas: only those with a link (the others are only in the node list). */
  const linkedNodes = useMemo(() => workspace?.nodes.filter((node) => linked.has(node.id)) ?? [], [workspace, linked]);

  const openNode = (node: NodeRecord) => setDialog({ kind: 'edit', node });
  const openMenu = (node: NodeRecord, x: number, y: number) => setMenu({ source: node.id, x, y });
  const closeMenu = () => {
    setMenu(undefined);
    setHighlighted(undefined);
  };

  const showWorkspace = useCallback(
    () =>
      window.workspaceBridge.current().then((next) => {
        // The saved layout changes as the canvas saves it: it does not make the workspace another one.
        const json = JSON.stringify({ ...next, layout: undefined });
        if (json !== shown.current) setOpened((count) => count + 1);
        setWorkspace(next);
      }),
    [],
  );

  const newWorkspace = async () => {
    setError(undefined);
    setNewWorkspaceLocation((await ab.workspace.beginNew()).location);
  };

  const openWorkspace = useCallback(async () => {
    setError(undefined);
    try {
      await ab.workspace.open();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    await showWorkspace();
  }, [showWorkspace]);

  /** Runs a change to the network and shows the workspace it leaves (or the error). */
  const change = async (action: () => Promise<WorkspaceResult>) => {
    setError(undefined);
    const result = await action();
    setWorkspace(result.workspace);
    if (result.status === 'failed') setError(result.message);
    return result;
  };

  /** Creates a link and opens the link dialog for it. */
  const createLink = async (source: string, target: string) => {
    const before = new Set(workspace?.links.map((link) => link.id));
    const result = await change(() => window.workspaceBridge.createLink(source, target));
    const created = result.status === 'failed' ? undefined : result.workspace?.links.find((link) => !before.has(link.id));
    if (created) setWeighing(created);
  };

  /** Closes the node dialog and runs the change it asked for. */
  const submit = async (action: () => Promise<WorkspaceResult>) => {
    setDialog(undefined);
    await change(action);
  };

  useEffect(() => {
    void showWorkspace();
  }, [showWorkspace]);

  // Hotkeys for the toolbar buttons: Ctrl+O opens a workspace, Ctrl+N opens the node dialog. Like the buttons, they do nothing while a
  // dialog is open. (Electron's default menu, which Terrane keeps, uses neither.)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || document.querySelector('dialog[open], [role=dialog]')) return;
      const key = event.key.toLowerCase();
      if (key === 'o') {
        event.preventDefault();
        void openWorkspace();
      } else if (key === 'n') {
        event.preventDefault();
        setDialog({ kind: 'create' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openWorkspace]);

  return (
    <div className="flex h-screen flex-col">
      <Toolbar
        onNewWorkspace={() => void newWorkspace()}
        onOpenWorkspace={() => void openWorkspace()}
        onAdd={() => setDialog({ kind: 'create' })}
        onImport={() => {
          setError(undefined);
          setImporting(true);
        }}
      />
      {importing && (
        <ImportDialog
          onImported={(result) => {
            setImporting(false);
            setWorkspace(result.workspace);
          }}
          onCancel={() => setImporting(false)}
        />
      )}
      {dialog?.kind === 'create' && <NodeDialog onSubmit={(input) => void submit(() => window.workspaceBridge.createNode(input))} onCancel={() => setDialog(undefined)} />}
      {dialog?.kind === 'edit' && (
        <NodeDialog node={dialog.node} onSubmit={(input) => void submit(() => window.workspaceBridge.updateNode(dialog.node.id, input))} onCancel={() => setDialog(undefined)} />
      )}
      {newWorkspaceLocation !== null && (
        <NewWorkspaceDialog
          initialLocation={newWorkspaceLocation}
          onChooseLocation={async () => (await ab.workspace.chooseLocation())?.location ?? null}
          onCreate={async (name) => {
            await ab.workspace.create({ name });
            setNewWorkspaceLocation(null);
            await showWorkspace();
          }}
          onCancel={() => setNewWorkspaceLocation(null)}
        />
      )}
      {error && <p role="alert" data-testid="error" className="m-4 rounded bg-red-50 p-3 text-red-800">{error}</p>}
      <SplitView
        direction="row"
        initialFirst={0.1}
        first={workspace?.open && <NodeList nodes={workspace.nodes} linked={linked} onOpenNode={openNode} onNodeMenu={openMenu} />}
        second={
          workspace?.open && (
            <Canvas
              key={opened}
              saved={workspace.layout}
              onLayout={(layout) => void window.workspaceBridge.saveLayout(layout).catch(() => undefined)}
              nodes={linkedNodes}
              links={workspace.links}
              onCreateLink={(source, target) => void createLink(source, target)}
              onUpdateLink={(link, input) => void change(() => window.workspaceBridge.updateLink(link, input))}
              onOpenNode={openNode}
              onNodeMenu={openMenu}
              highlighted={highlighted}
            />
          )
        }
      />
      {menu && workspace?.open && (
        <NodeMenu
          source={menu.source}
          nodes={workspace.nodes}
          linked={linked}
          links={workspace.links}
          x={menu.x}
          y={menu.y}
          onHover={setHighlighted}
          onSelect={(target) => {
            closeMenu();
            void createLink(menu.source, target);
          }}
          onCancel={closeMenu}
        />
      )}
      {weighing && (
        <LinkDialog
          link={weighing}
          onClose={(input) => {
            setWeighing(undefined);
            if (input && linkChanged(weighing, input)) void change(() => window.workspaceBridge.updateLink(weighing.id, input));
          }}
        />
      )}
    </div>
  );
}
