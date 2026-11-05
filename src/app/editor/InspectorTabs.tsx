'use client';

import { History, SlidersHorizontal, Upload } from 'lucide-react';

const TABS = [
  { id: 'edit', label: 'Edit', Icon: SlidersHorizontal },
  { id: 'history', label: 'History', Icon: History },
  { id: 'deliver', label: 'Deliver', Icon: Upload },
] as const;

export type InspectorTab = typeof TABS[number]['id'];

export function InspectorTabs({ active, count, onChange }: { active: InspectorTab; count: number; onChange: (tab: InspectorTab) => void }) {
  return (
    <div className="inspector-tabs" role="tablist" aria-label="Inspector sections">
      {TABS.map(({ id, label, Icon }, index) => (
        <button
          key={id}
          id={`inspector-tab-${id}`}
          type="button"
          role="tab"
          aria-selected={active === id}
          aria-controls={`inspector-panel-${id}`}
          tabIndex={active === id ? 0 : -1}
          onClick={() => onChange(id)}
          onKeyDown={(event) => {
            let next = index;
            if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
            else if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = TABS.length - 1;
            else return;
            event.preventDefault();
            const tab = TABS[next];
            if (tab) {
              onChange(tab.id);
              document.getElementById(`inspector-tab-${tab.id}`)?.focus();
            }
          }}
        >
          <Icon size={15} aria-hidden="true" /> {label}
          {id === 'history' && count > 0 && <span className="tab-count" aria-hidden="true">{count}</span>}
        </button>
      ))}
    </div>
  );
}
