import { useEffect, useRef, useState, type PointerEvent } from 'react';

interface WeightDialogProps {
  weight: number;
  /** The dialog was closed; `weight` is the slider's value, or the weight it opened with if it was cancelled. */
  onClose: (weight: number) => void;
}

/**
 * What double-clicking a link, or creating one, opens (D11, D16): a slider for the link's weight (1–10) in its centre,
 * with the weight (rounded to a whole number) above it, a Save button that sets it, and a Cancel button that leaves
 * the weight the dialog opened with. Escape, or a press off the dialog, cancels it too.
 */
export function WeightDialog({ weight, onClose }: WeightDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(weight);
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
      onClose={() => onClose(cancelled.current ? weight : value)}
      data-testid="weight-dialog"
      className="m-auto w-80 rounded p-4 shadow-lg backdrop:bg-black/30"
    >
      <div className="flex flex-col items-center gap-4">
        <output data-testid="weight-value">{Math.round(value)}</output>
        <input type="range" min={1} max={10} step="any" aria-label="Weight" data-testid="weight-slider" value={value} onChange={(event) => setValue(Number(event.target.value))} className="w-48" />
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="weight-cancel"
            className="rounded px-3 py-1.5 text-slate-600 hover:bg-slate-100"
            onClick={cancel}
          >
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
