import fileImportIcon from './icons/file-import.svg';
import folderOpenIcon from './icons/folder-open.svg';
import folderPlusIcon from './icons/folder-plus.svg';
import plusIcon from './icons/plus.svg';

/** The horizontal strip of buttons at the top of the screen. */
export function Toolbar({ onNewWorkspace, onOpenWorkspace, onAdd, onImport }: { onNewWorkspace(): void; onOpenWorkspace(): void; onAdd(): void; onImport(): void }) {
  return (
    <nav className="flex items-center gap-1 border-b border-slate-200 p-1" data-testid="toolbar">
      <ToolbarButton label="New workspace" icon={folderPlusIcon} testId="new-workspace" onClick={onNewWorkspace} />
      <ToolbarButton label="Open workspace" icon={folderOpenIcon} testId="open-workspace" onClick={onOpenWorkspace} />
      <ToolbarButton label="Add" icon={plusIcon} testId="add" onClick={onAdd} />
      <ToolbarButton label="Import" icon={fileImportIcon} testId="import" onClick={onImport} />
    </nav>
  );
}

function ToolbarButton({ label, icon, testId, onClick }: { label: string; icon: string; testId: string; onClick?: () => void }) {
  return (
    <button type="button" title={label} aria-label={label} data-testid={testId} onClick={onClick} className="rounded p-1.5 hover:bg-slate-100">
      <img src={icon} alt="" className="h-5 w-5" />
    </button>
  );
}
