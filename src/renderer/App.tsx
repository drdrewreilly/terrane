import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ab } from './ab';
import { Canvas } from './Canvas';
import { CanvasMenu } from './CanvasMenu';
import { ImportDialog } from './ImportDialog';
import { LinkDialog, linkChanged } from './LinkDialog';
import { LinkList } from './LinkList';
import { LinkMenu } from './LinkMenu';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';
import { hasCopiedFile, KeepCopyDialog, NodeDialog } from './NodeDialog';
import { NodeList } from './NodeList';
import { linkTargets, NodeMenu } from './NodeMenu';
import { NodeTypeManager, typeOf } from './NodeTypes';
import { SplitView } from './SplitView';
import { Toolbar } from './Toolbar';

/**
 * A toolbar (new workspace, open workspace, add, import, relayout, node types) above the node list (left), the canvas, which
 * shows the network of the nodes that have a link (centre), and the link list (right), each split from the next by a
 * draggable splitter. Right-clicking a node in either opens the node popup, and
 * right-clicking a link on the canvas opens the link popup, and right-clicking an empty part of the canvas opens the canvas popup. Workspaces are created and opened
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
  /** Whether the node type manager is open. */
  const [managingTypes, setManagingTypes] = useState(false);
  /** Whether the import dialog is open. */
  const [importing, setImporting] = useState(false);
  /** How many times the toolbar's button has asked for the network to be laid out from scratch (see Canvas). */
  const [relayouts, setRelayouts] = useState(0);
  /** The location the "new workspace" dialog starts with; `null` while the dialog is closed. */
  const [newWorkspaceLocation, setNewWorkspaceLocation] = useState<string | null>(null);

  /** The node popup being shown: for the node right-clicked (`source`), at (`x`, `y`) in the window. */
  const [menu, setMenu] = useState<{ source: string; x: number; y: number }>();
  /** The node highlighted on the canvas: the one the pointer is over in the node popup. */
  const [highlighted, setHighlighted] = useState<string>();
  /** The link whose link dialog is open: one just created, or one double-clicked in the link list. */
  const [weighing, setWeighing] = useState<WorkspaceLink>();
  /** The canvas popup being shown: for a right-click on an empty part of the canvas, at (`x`, `y`) in the window. */
  const [canvasMenu, setCanvasMenu] = useState<{ x: number; y: number }>();
  /** The link popup being shown: for the link right-clicked, at (`x`, `y`) in the window. */
  const [linkMenu, setLinkMenu] = useState<{ link: string; x: number; y: number }>();
  /** The node being deleted whose file was copied into the workspace, while asking whether to keep the copy. */
  const [deleting, setDeleting] = useState<NodeRecord>();
  /** The ids of the nodes that have at least one link. */
  const linked = useMemo(() => new Set(workspace?.links.flatMap((link) => [link.source, link.target]) ?? []), [workspace]);
  /** The nodes shown on the canvas: only those with a link (the others are only in the node list). */
  const linkedNodes = useMemo(() => workspace?.nodes.filter((node) => linked.has(node.id)) ?? [], [workspace, linked]);
  /** The background colour of each node's display: that of its type. */
  const colours = useMemo(() => new Map(workspace?.nodes.map((node) => [node.id, typeOf(node, workspace.nodeTypes)?.colour ?? '#ffffff']) ?? []), [workspace]);

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

  /**
   * Deletes a node (from the node popup or the node dialog), first asking whether to keep its file if that was copied into
   * the workspace. Its links go with it, so any node left without a link moves to the node list's unlinked part and off
   * the canvas.
   */
  const deleteNode = (node: NodeRecord, keepCopy?: boolean) => {
    if (keepCopy === undefined && hasCopiedFile(node)) {
      setDeleting(node);
      return;
    }
    setDeleting(undefined);
    setDialog((current) => (current?.kind === 'edit' && current.node.id === node.id ? undefined : current));
    setHighlighted(undefined);
    void change(() => window.workspaceBridge.deleteNode(node.id, keepCopy));
  };

  /** Deletes a link (from the link popup or a link dialog); a node it leaves without a link moves to the unlinked part. */
  const deleteLink = (id: string) => void change(() => window.workspaceBridge.deleteLink(id));

  /**
   * Closes the node dialog and runs the change it asked for; then, if a node was chosen under "Link to...", links the
   * node (`source`, or for a new node the one just created) to it, which opens the link dialog as any new link does.
   */
  const submit = async (action: () => Promise<WorkspaceResult>, linkTo?: string, source?: string) => {
    setDialog(undefined);
    const before = new Set(workspace?.nodes.map((node) => node.id));
    const result = await change(action);
    if (!linkTo || result.status === 'failed') return;
    const from = source ?? result.workspace.nodes.find((node) => !before.has(node.id))?.id;
    if (from) await createLink(from, linkTo);
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
        onRelayout={() => setRelayouts((count) => count + 1)}
        onNodeTypes={() => {
          setError(undefined);
          if (workspace?.open) setManagingTypes(true);
        }}
      />
      {managingTypes && workspace?.open && (
        <NodeTypeManager
          nodeTypes={workspace.nodeTypes}
          nodes={workspace.nodes}
          onCreate={(input) => change(() => window.workspaceBridge.createNodeType(input))}
          onUpdate={(id, input) => change(() => window.workspaceBridge.updateNodeType(id, input))}
          onDelete={(id) => change(() => window.workspaceBridge.deleteNodeType(id))}
          onClose={() => setManagingTypes(false)}
        />
      )}
      {importing && (
        <ImportDialog
          onImported={(result) => {
            setImporting(false);
            setWorkspace(result.workspace);
          }}
          onCancel={() => setImporting(false)}
        />
      )}
      {dialog?.kind === 'create' && <NodeDialog titles={workspace?.nodes.map((node) => node.title) ?? []} nodeTypes={workspace?.nodeTypes ?? []} linkTargets={linkTargets(undefined, workspace?.nodes ?? [], workspace?.links ?? [], linked)} onSubmit={(input, linkTo) => void submit(() => window.workspaceBridge.createNode(input), linkTo)} onCancel={() => setDialog(undefined)} />}
      {dialog?.kind === 'edit' && (
        <NodeDialog
          node={dialog.node}
          titles={workspace?.nodes.filter((node) => node.id !== dialog.node.id).map((node) => node.title) ?? []}
          nodeTypes={workspace?.nodeTypes ?? []}
          linkTargets={linkTargets(dialog.node.id, workspace?.nodes ?? [], workspace?.links ?? [], linked)}
          onSubmit={(input, linkTo) => void submit(() => window.workspaceBridge.updateNode(dialog.node.id, input), linkTo, dialog.node.id)}
          onCancel={() => setDialog(undefined)}
          onDelete={() => deleteNode(dialog.node)}
        />
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
        first={workspace?.open && <NodeList nodes={workspace.nodes} nodeTypes={workspace.nodeTypes} linked={linked} onOpenNode={openNode} onNodeMenu={openMenu} />}
        second={
          workspace?.open && (
            <SplitView
              direction="row"
              sizeSecond
              // The link list starts at a tenth of the window: the share is of what the node list leaves.
              initialFirst={1 / 9}
              first={
                <Canvas
                  key={opened}
                  saved={workspace.layout}
                  relayouts={relayouts}
                  onLayout={(layout) => void window.workspaceBridge.saveLayout(layout).catch(() => undefined)}
                  nodes={linkedNodes}
                  links={workspace.links}
                  colours={colours}
                  onCreateLink={(source, target) => void createLink(source, target)}
                  onUpdateLink={(link, input) => void change(() => window.workspaceBridge.updateLink(link, input))}
                  onDeleteLink={deleteLink}
                  onLinkMenu={(link, x, y) => setLinkMenu({ link: link.id, x, y })}
                  onOpenNode={openNode}
                  onNodeMenu={openMenu}
                  highlighted={highlighted}
                  onCanvasMenu={(x, y) => setCanvasMenu({ x, y })}
                />
              }
              second={<LinkList links={workspace.links} nodes={workspace.nodes} onOpenLink={setWeighing} onLinkMenu={(link, x, y) => setLinkMenu({ link: link.id, x, y })} />}
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
          onDelete={() => {
            const node = workspace.nodes.find((candidate) => candidate.id === menu.source);
            closeMenu();
            if (node) deleteNode(node);
          }}
          onCancel={closeMenu}
        />
      )}
      {canvasMenu && (
        <CanvasMenu
          x={canvasMenu.x}
          y={canvasMenu.y}
          onCreateNode={() => {
            setCanvasMenu(undefined);
            setDialog({ kind: 'create' });
          }}
          onCancel={() => setCanvasMenu(undefined)}
        />
      )}
      {linkMenu && (
        <LinkMenu
          x={linkMenu.x}
          y={linkMenu.y}
          onDelete={() => {
            setLinkMenu(undefined);
            deleteLink(linkMenu.link);
          }}
          onCancel={() => setLinkMenu(undefined)}
        />
      )}
      {deleting && (
        <KeepCopyDialog
          question="Keep the node's file, copied into the workspace, in the workspace folder?"
          onAnswer={(keep) => deleteNode(deleting, keep)}
          onCancel={() => setDeleting(undefined)}
        />
      )}
      {weighing && (
        <LinkDialog
          link={weighing}
          onClose={(input) => {
            setWeighing(undefined);
            if (input && linkChanged(weighing, input)) void change(() => window.workspaceBridge.updateLink(weighing.id, input));
          }}
          onDelete={() => deleteLink(weighing.id)}
        />
      )}
    </div>
  );
}
