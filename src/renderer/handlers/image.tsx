import { useEffect, useState } from 'react';
import { displayLines } from './display';
import type { Handler } from './types';

const MIME_TYPES: Record<string, string> = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml' };

/** Whether an image node's display shows its image: only if the node's body is empty or not shown. */
export const showsImage = (node: TerraneNode) => node.body === null || !node.display.includes('body');

/** The image behind an image node, as a data URL, once it has been read (while `enabled`); undefined until then or if it cannot be read. */
export function useNodeImage(node: FileNode, enabled: boolean): string | undefined {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const mime = MIME_TYPES[node.filename.slice(node.filename.lastIndexOf('.') + 1).toLowerCase()];
    window.workspaceBridge.readNode(node.id).then(
      (base64) => current && setSrc(`data:${mime};base64,${base64}`),
      () => undefined, // the file cannot be read: the lines are still shown
    );
    return () => {
      current = false;
    };
  }, [node.id, node.filename, node.path, enabled]);
  return src;
}

/**
 * Takes jpeg, png and svg files. Its markup is deliberately its own copy rather than shared with the default
 * handler, so the image handler can change without touching the default one.
 *
 * The image is shown only if the node's body is empty or not shown. Then the display is portrait: a square above (the
 * image, always fully visible at its own aspect ratio) and the display lines below, which take 20% of the height.
 * Otherwise it is a 100×100 white square showing the display lines.
 */
export const imageHandler: Handler = {
  id: 'image',
  extensions: ['jpeg', 'jpg', 'png', 'svg'],
  Component: ({ node }) => {
    const showImage = showsImage(node);
    const src = useNodeImage(node, showImage);

    const lines = displayLines(node);
    if (!showImage) {
      return (
        <div data-testid="node" data-handler="image" className="flex h-[100px] w-[100px] flex-col items-center justify-center overflow-hidden break-words rounded border border-slate-300 bg-[var(--node-colour,#ffffff)] p-1 text-center text-sm">
          {lines.map((line, index) => (
            <div key={index} data-testid="node-line" className="w-full whitespace-pre-line">
              {line}
            </div>
          ))}
        </div>
      );
    }
    return (
      <div data-testid="node" data-handler="image" className="flex h-[125px] w-[100px] flex-col overflow-hidden rounded bg-[var(--node-colour,#ffffff)] ring-1 ring-slate-300">
        <div data-testid="node-image" className="flex h-[80%] w-full items-center justify-center">
          {src && <img src={src} alt={node.filename} className="h-full w-full object-contain" />}
        </div>
        <div data-testid="node-text" className="flex h-[20%] w-full flex-col items-center justify-center px-1">
          {lines.map((line, index) => (
            <span key={index} data-testid="node-line" title={line} className="w-full truncate text-center text-xs">
              {line}
            </span>
          ))}
        </div>
      </div>
    );
  },
};
