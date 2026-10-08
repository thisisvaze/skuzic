import { useId, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import './watercolor-button.css';

/** Blue pigment blooms like water on paper on hover; the label stays still. */
export function WatercolorButton({
  children,
  className,
  type = 'button',
  ...props
}: ComponentProps<'button'>) {
  const id = useId().replace(/:/g, '');

  return (
    <button {...props} type={type} className={cn('watercolor-button', className)}>
      <svg
        className="watercolor-button__paint"
        viewBox="0 0 240 64"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <filter id={`${id}-grain`} x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" seed="12" />
            <feColorMatrix type="saturate" values="0" />
            <feComposite in2="SourceGraphic" operator="in" />
          </filter>
          <filter id={`${id}-water`} x="-30%" y="-50%" width="160%" height="200%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.025 0.065" numOctaves="3" seed="4" result="water" />
            <feDisplacementMap in="SourceGraphic" in2="water" scale="20" xChannelSelector="R" yChannelSelector="G" />
            <feGaussianBlur stdDeviation="1.4" />
          </filter>
          <radialGradient id={`${id}-bloom`}>
            <stop stopColor="#62a9d6" stopOpacity="0.3" />
            <stop offset="0.5" stopColor="#539acd" stopOpacity="0.25" />
            <stop offset="0.76" stopColor="#173f7e" stopOpacity="0.25" />
            <stop offset="1" stopColor="#173f7e" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-light`}>
            <stop stopColor="#a6d6ed" stopOpacity="0.24" />
            <stop offset="0.55" stopColor="#75b8e0" stopOpacity="0.16" />
            <stop offset="1" stopColor="#75b8e0" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-deep`}>
            <stop stopColor="#163f87" stopOpacity="0.36" />
            <stop offset="1" stopColor="#163f87" stopOpacity="0" />
          </radialGradient>
        </defs>
        <g>
          <ellipse cx="48" cy="14" rx="110" ry="42" fill={`url(#${id}-light)`} />
          <ellipse cx="188" cy="60" rx="92" ry="47" fill={`url(#${id}-light)`} />
          <ellipse cx="115" cy="57" rx="95" ry="35" fill={`url(#${id}-deep)`} />
          <ellipse cx="224" cy="4" rx="74" ry="40" fill={`url(#${id}-deep)`} />
        </g>
        {/* The button clips these soft pools to its crisp, smooth corners. */}
        <g filter={`url(#${id}-water)`}>
          <g className="watercolor-button__bloom watercolor-button__bloom--first">
            <ellipse cx="58" cy="19" rx="108" ry="56" fill={`url(#${id}-bloom)`} />
          </g>
          <g className="watercolor-button__bloom watercolor-button__bloom--second">
            <ellipse cx="187" cy="56" rx="101" ry="58" fill={`url(#${id}-bloom)`} />
          </g>
        </g>
        <rect
          className="watercolor-button__grain"
          x="0" y="0" width="240" height="64"
          fill="white"
          filter={`url(#${id}-grain)`}
        />
      </svg>
      <span className="watercolor-button__label">{children}</span>
    </button>
  );
}
