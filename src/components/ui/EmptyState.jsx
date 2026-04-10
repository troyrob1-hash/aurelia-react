// src/components/ui/EmptyState.jsx
const ICONS = {
  users: (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="24" cy="18" r="8" stroke="currentColor" strokeWidth="1.5" fill="none"/>
      <path d="M8 42c0-8.837 7.163-16 16-16s16 7.163 16 16" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
    </svg>
  ),
  locations: (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M24 4C16.268 4 10 10.268 10 18c0 10.5 14 26 14 26s14-15.5 14-26c0-7.732-6.268-14-14-14z" stroke="currentColor" strokeWidth="1.5" fill="none"/>
      <circle cx="24" cy="18" r="5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
    </svg>
  ),
  keys: (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="18" cy="24" r="8" stroke="currentColor" strokeWidth="1.5" fill="none"/>
      <path d="M24 24h16m-4-4v8m-6-8v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  activity: (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="8" width="32" height="32" rx="4" stroke="currentColor" strokeWidth="1.5" fill="none"/>
      <path d="M16 20h16M16 28h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  default: (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="8" width="32" height="32" rx="4" stroke="currentColor" strokeWidth="1.5" fill="none"/>
      <path d="M18 24h12M24 18v12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
};

export default function EmptyState({ title, description, action, icon }) {
  const svg = ICONS[icon] || ICONS.default;
  return (
    <div className="empty-state">
      <div style={{ color: "var(--color-text-tertiary, #bbb)", marginBottom: 12 }}>{svg}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action && (
        <button className="btn-primary" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
