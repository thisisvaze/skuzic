import { type ReactNode } from 'react';
import { motion, useIsPresent, useReducedMotion } from 'motion/react';

export const MIXER_EASE = [0.22, 1, 0.36, 1] as const;

/** Keep departing controls around just long enough to fold away, but not interactive. */
export function MixerReveal({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  const present = useIsPresent();
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      id={id}
      inert={!present}
      aria-hidden={!present || undefined}
      // Clip only while folding. Once open, card rings, shadows and focus rings
      // paint a pixel or two past the edge and would be cut off.
      initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
      animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
      exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
      transition={{ duration: reduceMotion ? 0 : 0.32, ease: MIXER_EASE }}
    >
      <div className={className}>{children}</div>
    </motion.div>
  );
}
