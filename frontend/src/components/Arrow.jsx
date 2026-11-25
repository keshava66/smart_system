import { ArrowDown, ArrowRight, ArrowUp, ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';

// Direction marks as drawn icons instead of text glyphs, so trends, sort
// headers and disclosures share one stroke, scale with the text around them
// and sit on its baseline.
const ICONS = {
  up: ArrowUp, down: ArrowDown, right: ArrowRight,
  asc: ChevronUp, desc: ChevronDown,
  open: ChevronDown, closed: ChevronRight,
};

export default function Arrow({ dir, className }) {
  const Icon = ICONS[dir];
  return <Icon className={className} size="1em" strokeWidth={2.5} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', flex: 'none' }} />;
}
