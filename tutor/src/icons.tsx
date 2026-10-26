// Stroke icons (24px grid, 1.8 stroke), inline so the app works offline.
type P = { size?: number }
const svg = (d: React.ReactNode) =>
  function Icon({ size = 16 }: P) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {d}
      </svg>
    )
  }

export const Plus = svg(<path d="M12 5v14M5 12h14" />)
export const Gear = svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </>
)
export const Minus = svg(<path d="M5 12h14" />)
export const Folder = svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />)
export const Chevron = svg(<path d="m6 9 6 6 6-6" />)
export const Scan = svg(
  <>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
    <circle cx="12" cy="12" r="3" />
  </>
)
export const ArrowUp = svg(<path d="M12 19V5M5 12l7-7 7 7" />)
export const Square = svg(<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />)
export const Check = svg(<path d="m5 12 5 5 9-10" />)
export const X = svg(<path d="M18 6 6 18M6 6l12 12" />)
export const Copy = svg(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h8" />
  </>
)
export const Layers = svg(<path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5" />)
export const Flow = svg(
  <>
    <circle cx="5" cy="6" r="2" />
    <circle cx="19" cy="18" r="2" />
    <path d="M7 6h6a4 4 0 0 1 4 4v6" />
  </>
)
export const Lightbulb = svg(<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />)
export const Zap = svg(<path d="M13 2 4 14h7l-1 8 9-12h-7z" />)
export const Code = svg(<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16" />)
export const Wrench = svg(<path d="M14.7 6.3a4 4 0 0 0 5 5L22 14l-8 8-2.3-2.3a4 4 0 0 0-5-5L4 12l8-8z" />)
export const Sparkle = svg(<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />)
export const Beaker = svg(<path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3" />)
export const Book = svg(<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21V5" />)
export const Pencil = svg(<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />)
export const Pin = svg(<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z" />)
export const Clock = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>
)
export const Trash = svg(<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />)
export const Ide = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m8 10 2 2-2 2M12 14h4" />
  </>
)
export const Search = svg(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>
)
export const Insert = svg(<path d="M4 12h11M11 8l4 4-4 4M20 5v14" />)
export const Diff = svg(<path d="M12 3v8M8 7h8M8 17h8M5 21h14a0 0 0 0 0 0 0V3H5z" />)
export const Undo = svg(<path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />)
export const Sidebar = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </>
)
export const Wide = svg(<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4" />)
export const Narrow = svg(<path d="M3 12h7M21 12h-7M6 8l4 4-4 4M18 8l-4 4 4 4" />)
export const Circle = svg(<circle cx="12" cy="12" r="7" />)
export const CircleHalf = svg(
  <>
    <circle cx="12" cy="12" r="7" />
    <path d="M12 5a7 7 0 0 1 0 14z" fill="currentColor" />
  </>
)
export const CircleCheck = svg(
  <>
    <circle cx="12" cy="12" r="8" fill="currentColor" stroke="none" />
    <path d="m8.5 12 2.5 2.5 4.5-5" stroke="#111217" />
  </>
)
export const ChevronRight = svg(<path d="m9 6 6 6-6 6" />)
export const Terminal = svg(<path d="m5 8 4 4-4 4M12 16h7" />)
export const Chat = svg(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />)
export const ArrowRight = svg(<path d="M5 12h14M13 6l6 6-6 6" />)
export const Play = svg(<path d="M7 5v14l11-7Z" />)
export const Link = svg(
  <>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </>
)
export const Target = svg(
  <>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="12" cy="12" r="0.8" fill="currentColor" />
  </>
)
export const Route = svg(<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14" />)
