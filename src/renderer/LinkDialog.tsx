import { useEffect, useRef, useState, type PointerEvent } from 'react';

/** Whether saving `input` would change `link` (an empty description is the same as none). */
export const linkChanged = (link: WorkspaceLink, input: LinkInput) => input.weight !== link.weight || (input.description || null) !== link.description;

interface LinkDialogProps {
  link: WorkspaceLink;
  /** The dialog was closed: with the link's weight and description from Save, or with nothing if it was cancelled. */
  onClose: (input?: LinkInput) => void;
}

/**
 * What double-clicking a link, or creating one, opens (D11, D16): a slider for the link's weight (1–10) in its centre,
 * with the weight (rounded to a whole number) above it, a text area for the link's description, a Save button that sets
 * both, and a Cancel button that leaves the link as it was. Escape, or a press off the dialog, cancels it too.
 */
export function LinkDialog({ link, onClose }: LinkDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [weight, setWeight] = useState(link.weight);
  const [description, setDescription] = useState(link.description ?? '');
  /** Whether the dialog is being closed by cancelling it (Cancel, Escape, or a press off the dialog). */
  const cancelled = useRef(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const cancel = () => {
    cancelled.current = true;
    dialog.current?.close();
  };

  /** A press off the dialog (on its backdrop, which takes presses as the dialog's own) cancels it. */
  const pressOff = (event: PointerEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) cancel();
  };

  return (
    <dialog
      ref={dialog}
      onCancel={() => (cancelled.current = true)}
      onPointerDown={pressOff}
      onClose={() => onClose(cancelled.current ? undefined : { weight, description })}
      data-testid="weight-dialog"
      className="m-auto w-80 rounded p-4 shadow-lg backdrop:bg-black/30"
    >
      <div className="flex flex-col items-center gap-4">
        <output data-testid="weight-value">{Math.round(weight)}</output>
        <input type="range" min={1} max={10} step="any" aria-label="Weight" data-testid="weight-slider" value={weight} onChange={(event) => setWeight(Number(event.target.value))} className="w-48" />
        <div className="flex w-full flex-col gap-1 text-sm">
          <label htmlFor="link-description">Description</label>
          <textarea
            id="link-description"
            data-testid="link-description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="resize-none rounded border border-slate-300 px-2 py-1"
          />
        </div>
        <div className="flex gap-2">
          <button type="button" data-testid="weight-cancel" className="rounded px-3 py-1.5 text-slate-600 hover:bg-slate-100" onClick={cancel}>
            Cancel
          </button>
          <button type="button" data-testid="weight-save" className="rounded bg-slate-900 px-3 py-1.5 text-white" onClick={() => dialog.current?.close()}>
            Save
          </button>
        </div>
      </div>
    </dialog>
  );
}
