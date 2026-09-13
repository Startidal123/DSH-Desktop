export function LogoMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" stroke="url(#lg)" strokeWidth="2" />
      <path
        d="M9 20.5c1.8 1.6 4.2 2.5 6.8 2.5 5.2 0 8.7-3.4 8.7-8.2 0-3.6-2.1-6.3-5.4-6.3-2.4 0-4.2 1.5-4.2 3.6 0 1.7 1.2 2.9 2.9 2.9 1 0 1.8-.4 2.3-1.1.7 2.3-1.4 4.3-4.3 4.3-2.9 0-5.1-1.8-6.8-4.4v6.7Z"
        fill="url(#lg)"
      />
      <defs>
        <linearGradient id="lg" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4d6bfe" />
          <stop offset="1" stopColor="#7b5cff" />
        </linearGradient>
      </defs>
    </svg>
  )
}

const icon = (path, viewBox = '0 0 24 24') => function Icon({ size = 18, className }) {
  return (
    <svg width={size} height={size} viewBox={viewBox} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {path}
    </svg>
  )
}

export const IconPlus = icon(<><path d="M12 5v14M5 12h14" /></>)
export const IconCheck = icon(<><path d="M20 6 9 17l-5-5" /></>)
export const IconSpark = icon(<><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" /></>)
export const IconSettings = icon(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.88v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" /></>)
export const IconSend = icon(<><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>)
export const IconTrash = icon(<><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></>)
export const IconChevron = icon(<><path d="m9 18 6-6-6-6" /></>)
export const IconRefresh = icon(<><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" /><path d="M21 3v5h-5" /></>)
export const IconFolder = icon(<><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></>)

/** Open folder (active workspace): blue stroke + translucent blue fill — the only colored icon in the sidebar */
export function IconFolderOpen({ size = 16, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`ws-open-icon ${className}`} aria-hidden>
      <path
        d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"
      />
    </svg>
  )
}
export const IconTool = icon(<><path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3Z" /></>)
export const IconImage = icon(<><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.9-3.9a2 2 0 0 0-2.8 0L5 20" /></>)
export const IconX = icon(<><path d="M18 6 6 18M6 6l12 12" /></>)
export const IconSearch = icon(<><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>)
export const IconDownload = icon(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>)
export const IconCopy = icon(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>)
export const IconHammer = icon(<><path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9" /><path d="m18 15 4-4" /><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" /></>)
export const IconPlan = icon(<><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 7h6M9 11h6M9 15h3" /></>)
