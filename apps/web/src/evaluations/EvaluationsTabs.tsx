import { useNavigate } from 'react-router-dom';
import { Tabs } from '@/ui';

export interface EvaluationsTabsProps {
  /** Which tab is active on the page rendering this bar. */
  active: 'datasets' | 'runs';
}

const ITEMS = [
  { value: 'datasets', label: 'Datasets' },
  { value: 'runs', label: 'Runs' },
];

const ROUTES: Record<string, string> = {
  datasets: '/evaluations',
  runs: '/evaluations/runs',
};

/**
 * The tab bar shared by the two `/evaluations` screens. Each tab is a real
 * route rather than local state, so a run history stays linkable and survives a
 * reload — and the bar itself is rendered by both pages so it does not shift
 * as you switch.
 *
 * @param active - The tab belonging to the page rendering this bar.
 */
export function EvaluationsTabs({ active }: EvaluationsTabsProps) {
  const navigate = useNavigate();

  return (
    <Tabs
      items={ITEMS}
      value={active}
      onChange={(value) => {
        if (value !== active) navigate(ROUTES[value]);
      }}
    />
  );
}
