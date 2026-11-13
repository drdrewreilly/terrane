import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { displayLines } from './display';
import type { Handler } from './types';

/** The golden mean: the default display's width divided by its height. */
const PHI = (1 + Math.sqrt(5)) / 2;
/** The default display's smallest width, in pixels (its height is this divided by PHI: 100). */
const MIN_WIDTH = 162;

interface Size {
  width: number;
  height: number;
}

const sizeFor = (width: number): Size => ({ width, height: Math.round(width / PHI) });

/**
 * The default display: a white landscape rectangle showing `children`. Its width is that of a golden-mean rectangle,
 * 162×100 unless its content needs more room, and then the smallest such rectangle that holds all of the content; its
 * height is then only as much as the content needs (no more than the golden-mean height), leaving no empty space above
 * or below the content. Shared with the text handler, which extends this one.
 */
export function DefaultRect({ handler, className = '', children }: { handler: string; className?: string; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => sizeFor(MIN_WIDTH));
  /** Counts the times fonts have finished loading: the text takes more or less room once its font is in. */
  const [fonts, setFonts] = useState(0);
  /** The text (and fonts) the current size was found for: the size is found again only when one of them changes. */
  const measured = useRef<string>(undefined);

  useEffect(() => {
    let current = true;
    const loaded = () => current && setFonts((count) => count + 1);
    void document.fonts.ready.then(loaded);
    document.fonts.addEventListener('loadingdone', loaded);
    return () => {
      current = false;
      document.fonts.removeEventListener('loadingdone', loaded);
    };
  }, []);

  useLayoutEffect(() => {
    const div = element.current!;
    const key = `${fonts}:${div.textContent ?? ''}`;
    if (measured.current === key) return;
    measured.current = key;
    // Whether the content fits at `width`: its height there (the display's own height left free) is no more than the
    // rectangle's. The content wraps more narrowly as the width grows, so the smallest width that fits is searched for.
    const fits = (width: number) => {
      div.style.width = `${width}px`;
      div.style.height = 'auto';
      return div.offsetHeight <= sizeFor(width).height;
    };
    let high = MIN_WIDTH;
    while (!fits(high)) high *= 2;
    let low = high === MIN_WIDTH ? MIN_WIDTH : high / 2;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (fits(middle)) high = middle;
      else low = middle;
    }
    // The width is that of the smallest golden-mean rectangle that holds the content; the height is then cut to the
    // content's own, so that the display has no empty space above and below it.
    const golden = sizeFor(Math.ceil(high));
    div.style.width = `${golden.width}px`;
    div.style.height = 'auto';
    const found = { width: golden.width, height: Math.min(golden.height, div.offsetHeight) };
    div.style.height = `${found.height}px`;
    setSize(found);
  });

  return (
    <div
      ref={element}
      data-testid="node"
      data-handler={handler}
      className={`flex flex-col items-center justify-center overflow-hidden break-words rounded border border-slate-300 bg-[var(--node-colour,#ffffff)] p-1 text-center text-sm ${className}`}
      style={size}
    >
      {children}
    </div>
  );
}

/** A node's display lines, each on a line of its own. */
export function DisplayLines({ node }: { node: TerraneNode }) {
  return displayLines(node).map((line, index) => (
    <div key={index} data-testid="node-line" className="w-full whitespace-pre-line">
      {line}
    </div>
  ));
}

/** Takes every file that no other handler claims. */
export const defaultHandler: Handler = {
  id: 'default',
  extensions: [],
  Component: ({ node }) => (
    <DefaultRect handler="default">
      <DisplayLines node={node} />
    </DefaultRect>
  ),
};
