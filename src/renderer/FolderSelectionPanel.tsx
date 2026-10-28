import { folderContains, folderIsChosen, type ReviewFolder } from './folder-selection';

interface Props {
  folders: ReviewFolder[];
  choices: Set<string>;
  stillCount: number;
  busy: boolean;
  onToggle(path: string): void;
  onAll(): void;
  onClear(): void;
  onApply(): void;
  onClose(): void;
}

export function FolderSelectionPanel({ folders, choices, stillCount, busy, onToggle, onAll, onClear, onApply, onClose }: Props) {
  return <section className="video-skip-panel folder-unselect-panel" aria-label="Unselect stills by folder">
    <h4>Unselect stills by folder</h4>
    <p>Choose delivery folders. Includes all videos and nested folders, regardless of the current filter. Drive changes apply when you save the review.</p>
    <div className="video-skip-tools">
      <button type="button" className="button button-secondary" onClick={onAll} disabled={busy || !folders.some(folder => folder.approved)}>Select all folders</button>
      <button type="button" className="button button-secondary" onClick={onClear} disabled={busy || !choices.size}>Clear folder choices</button>
    </div>
    <div className="video-skip-list">
      {folders.map(folder => {
        const inherited = [...choices].some(parent => parent !== folder.path && folderContains(folder.path, parent));
        return <label key={folder.path} style={{ paddingLeft: 4 + Math.min(folder.depth, 4) * 16 }} title={folder.path || 'Project folder'}>
          <input type="checkbox" aria-label={`Unselect stills in ${folder.path || 'Project folder'}`} checked={folderIsChosen(folder.path, choices)}
            disabled={busy || !folder.approved || inherited} onChange={() => onToggle(folder.path)} />
          <span><strong>{folder.label}</strong><small>{folder.approved} approved stills · {folder.total} candidates{inherited ? ' · Included by parent folder' : ''}</small></span>
        </label>;
      })}
    </div>
    <div className="video-skip-tools">
      <button type="button" className="button button-primary" onClick={onApply} disabled={busy || !stillCount}>Unselect {stillCount} {stillCount === 1 ? 'still' : 'stills'}</button>
      <button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>
    </div>
  </section>;
}
