import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Eraser, Undo2 } from 'lucide-react';

/**
 * A small drawing surface for the working that does not fit in words.
 *
 * ---------------------------------------------------------------------------
 * STROKES ARE THE STATE; THE PIXELS ARE A RENDERING OF IT
 * ---------------------------------------------------------------------------
 *
 * The naive canvas keeps only what is painted, which makes undo impossible
 * (nothing remembers what the last stroke covered) and makes a resize
 * destructive (the bitmap is thrown away or stretched). Keeping the strokes as
 * data and repainting from them makes undo a `pop`, resize a repaint, and
 * export a one-liner — and costs nothing, because a hand-drawn sketch is a few
 * thousand points at most.
 *
 * ---------------------------------------------------------------------------
 * DEVICE PIXEL RATIO, WHICH IS WHERE EVERY CANVAS BUG LIVES
 * ---------------------------------------------------------------------------
 *
 * A canvas has two sizes: the CSS box it occupies and the bitmap behind it. Set
 * only the CSS size and the bitmap stays 300×150 and is scaled up — the
 * blurriness that makes hand-drawn canvases look broken on a phone. So the
 * backing store is sized in DEVICE pixels (`width = cssWidth * dpr`) and the
 * context is scaled by `dpr` once, after which every coordinate in this file is
 * in CSS pixels and the arithmetic stays readable.
 *
 * Pointer coordinates come from `getBoundingClientRect`, which already accounts
 * for the element's real position — including the RTL layout around it. There
 * is deliberately no mirroring here: a sketch is a picture, not text, and
 * flipping it would turn a right-handed arrow into a left-handed one.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is not accessible to a screen reader, and no `aria` attribute can make a
 * freehand drawing readable. The honest mitigation is that the notes tab beside
 * it is fully accessible and is the primary surface; this one is labelled as an
 * optional scratch area rather than presented as an equal path.
 */

/** Pointer pressure is unreliable across devices, so the line is a fixed width. */
const LINE_WIDTH = 2.5;

export default function SketchPad({ value, onChange, ref }) {
  const canvasRef = useRef(null);
  const strokesRef = useRef([]);
  const drawingRef = useRef(false);
  const [isEmpty, setIsEmpty] = useState(!value);

  /** Repaint everything from the stroke list. */
  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    const { width, height } = canvas.getBoundingClientRect();

    context.clearRect(0, 0, width, height);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = LINE_WIDTH;
    // Read from the live stylesheet so the ink follows the theme: a near-black
    // stroke on the dark canvas would be invisible.
    context.strokeStyle = getComputedStyle(canvas).color;

    for (const stroke of strokesRef.current) {
      if (stroke.length === 0) continue;
      context.beginPath();
      context.moveTo(stroke[0].x, stroke[0].y);
      // A single tap has one point and would draw nothing with `lineTo` alone;
      // a dot is what the learner meant.
      if (stroke.length === 1) context.lineTo(stroke[0].x + 0.01, stroke[0].y);
      else for (const point of stroke.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
  }, []);

  /** Size the backing store to the box, in device pixels, then repaint. */
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height } = canvas.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const context = canvas.getContext('2d');
    // `setTransform`, not `scale`: this runs on every resize, and `scale`
    // compounds with whatever transform was already there.
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    repaint();
  }, [repaint]);

  useEffect(() => {
    resize();
    const observer = new ResizeObserver(resize);
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [resize]);

  /*
   * A saved drawing is restored as an IMAGE, not as strokes — the stroke list
   * is not persisted, only the picture. That is a deliberate trade: it keeps
   * the stored payload to one PNG instead of an unbounded point list, at the
   * cost of undo not reaching back across a reload. Undo after reopening the
   * notebook therefore starts from the restored image, which is the behaviour
   * a paper notebook has too.
   */
  useEffect(() => {
    if (!value) return;
    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.getContext('2d').drawImage(image, 0, 0, width, height);
      setIsEmpty(false);
    };
    image.src = value;
  }, [value]);

  const pointFrom = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handlePointerDown = (event) => {
    // Only the primary button/contact draws; a right-click or a second finger
    // would otherwise start a stroke nobody asked for.
    if (event.button !== 0) return;
    event.preventDefault();
    /*
     * Pointer capture is what makes a stroke survive leaving the canvas. Without
     * it, dragging past the edge ends the stroke where it left and a new one
     * starts on re-entry — the line breaks exactly where a person naturally
     * overshoots.
     */
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    strokesRef.current.push([pointFrom(event)]);
    setIsEmpty(false);
  };

  const handlePointerMove = (event) => {
    if (!drawingRef.current) return;
    strokesRef.current.at(-1).push(pointFrom(event));
    repaint();
  };

  const endStroke = useCallback(() => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    onChange?.(canvasRef.current.toDataURL('image/png'));
  }, [onChange]);

  const undo = () => {
    strokesRef.current.pop();
    repaint();
    const empty = strokesRef.current.length === 0;
    setIsEmpty(empty);
    onChange?.(empty ? null : canvasRef.current.toDataURL('image/png'));
  };

  const clear = () => {
    strokesRef.current = [];
    repaint();
    setIsEmpty(true);
    onChange?.(null);
  };

  useImperativeHandle(ref, () => ({
    toDataURL: () => (isEmpty ? null : (canvasRef.current?.toDataURL('image/png') ?? null)),
  }));

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] leading-relaxed text-text-muted">
          مساحة للرسم والمعادلات — ارسمي بالإصبع أو المؤشّر.
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <ToolButton onClick={undo} disabled={isEmpty} label="تراجع عن آخر خط">
            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
          </ToolButton>
          <ToolButton onClick={clear} disabled={isEmpty} label="مسح اللوح">
            <Eraser className="h-3.5 w-3.5" aria-hidden="true" />
          </ToolButton>
        </div>
      </div>

      {/*
        `touch-none` is not optional. Without it a drag on a touch screen scrolls
        the panel instead of drawing, and the canvas appears completely dead on
        exactly the devices where finger-drawing is the point.

        `text-text-main` is read back by `repaint` as the ink colour, so the
        stroke follows the theme with no JavaScript colour table.
      */}
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        role="img"
        aria-label="لوح رسم للمعادلات والرسومات التوضيحية"
        className="w-full flex-1 touch-none rounded-2xl border border-accent-subtle bg-canvas text-text-main"
      />
    </div>
  );
}

function ToolButton({ onClick, disabled, label, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted transition-colors duration-200 hover:bg-primary-light hover:text-primary disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}
