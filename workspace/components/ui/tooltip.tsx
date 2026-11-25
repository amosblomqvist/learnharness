"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import * as Popper from "@radix-ui/react-popper"
import { Presence } from "@radix-ui/react-presence"
import { useControllableState } from "@radix-ui/react-use-controllable-state"
import { Slot, VisuallyHidden, type Tooltip as TooltipPrimitive } from "radix-ui"
import { InteractionLayerOwner, useOptionalInteractionLayers } from "@/components/interaction-layers"
import { cn } from "@/lib/utils"

/** Cold pointer rest. Keyboard focus opens immediately; no tooltip owns keys. */
export const TOOLTIP_DELAY_MS = 500

type Timer = ReturnType<typeof setTimeout>
type Point = { x: number; y: number }
type ProviderState = {
  delay: number
  delayed: React.RefObject<boolean>
  inTransit: React.RefObject<boolean>
  opened(): void
  closed(): void
}
const ProviderContext = React.createContext<ProviderState | null>(null)
const openObservers = new Set<(identity: object) => void>()
const noSubscribe = () => () => {}
const emptySnapshot = () => null

function TooltipProvider({ delayDuration = TOOLTIP_DELAY_MS, skipDelayDuration = 300, children }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  const delayed = React.useRef(true)
  const inTransit = React.useRef(false)
  const warmTimer = React.useRef<Timer | null>(null)
  const opened = React.useCallback(() => {
    if (skipDelayDuration <= 0) return
    if (warmTimer.current !== null) clearTimeout(warmTimer.current)
    delayed.current = false
  }, [skipDelayDuration])
  const closed = React.useCallback(() => {
    if (skipDelayDuration <= 0) return
    if (warmTimer.current !== null) clearTimeout(warmTimer.current)
    warmTimer.current = setTimeout(() => { delayed.current = true }, skipDelayDuration)
  }, [skipDelayDuration])
  React.useEffect(() => () => { if (warmTimer.current !== null) clearTimeout(warmTimer.current) }, [])
  const value = React.useMemo(() => ({ delay: delayDuration, delayed, inTransit, opened, closed }), [delayDuration, opened, closed])
  return <ProviderContext.Provider value={value}>{children}</ProviderContext.Provider>
}

type TooltipState = {
  open: boolean
  state: "closed" | "delayed-open" | "instant-open"
  identity: object
  trigger: HTMLElement | null
  setTrigger: React.Dispatch<React.SetStateAction<HTMLElement | null>>
  setContent: React.Dispatch<React.SetStateAction<HTMLElement | null>>
  contentId: string
  setContentId(id?: string): void
  provider: ProviderState
  enter(): void
  leave(event: React.PointerEvent<HTMLElement>): void
  contentLeave(event: React.PointerEvent<HTMLElement>): void
  clearTransit(): void
  immediate(): void
  close(): void
}
const TooltipContext = React.createContext<TooltipState | null>(null)
function useTooltip() {
  const value = React.useContext(TooltipContext)
  if (!value) throw new Error("Tooltip parts require Tooltip")
  return value
}

/** Standard convex hull/ray intersection for the optional hover transit area. */
function hull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  const half = (list: Point[]) => {
    const result: Point[] = []
    for (const point of list) {
      while (result.length > 1 && cross(result[result.length - 2]!, result[result.length - 1]!, point) <= 0) result.pop()
      result.push(point)
    }
    return result.slice(0, -1)
  }
  return [...half(sorted), ...half(sorted.reverse())]
}
function containsPoint(polygon: Point[], point: Point) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
function transitArea(event: React.PointerEvent<HTMLElement>, target: HTMLElement): Point[] {
  const from = event.currentTarget.getBoundingClientRect(), to = target.getBoundingClientRect()
  const distances = [Math.abs(from.left - event.clientX), Math.abs(from.right - event.clientX), Math.abs(from.top - event.clientY), Math.abs(from.bottom - event.clientY)]
  const exit = distances.indexOf(Math.min(...distances))
  const x = event.clientX, y = event.clientY
  const edge = exit === 0 ? [{ x: x + 5, y: y - 5 }, { x: x + 5, y: y + 5 }]
    : exit === 1 ? [{ x: x - 5, y: y - 5 }, { x: x - 5, y: y + 5 }]
    : exit === 2 ? [{ x: x - 5, y: y + 5 }, { x: x + 5, y: y + 5 }]
    : [{ x: x - 5, y: y - 5 }, { x: x + 5, y: y - 5 }]
  return hull([...edge, { x: to.left, y: to.top }, { x: to.right, y: to.top }, { x: to.right, y: to.bottom }, { x: to.left, y: to.bottom }])
}

function Tooltip({ children, open: openProp, defaultOpen, onOpenChange, delayDuration, disableHoverableContent = true }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const provider = React.useContext(ProviderContext)
  if (!provider) throw new Error("Tooltip requires TooltipProvider")
  const identity = React.useRef({}).current
  const delayedOpen = React.useRef(false)
  const openTimer = React.useRef<Timer | null>(null)
  const [trigger, setTrigger] = React.useState<HTMLElement | null>(null)
  const [content, setContent] = React.useState<HTMLElement | null>(null)
  const generatedId = React.useId()
  const [contentId, setId] = React.useState(generatedId)
  const setContentId = React.useCallback((id?: string) => setId(id ?? generatedId), [generatedId])
  const [corridor, setCorridor] = React.useState<Point[] | null>(null)
  const [open, setOpen] = useControllableState({
    prop: openProp, defaultProp: defaultOpen ?? false, caller: "Tooltip",
    onChange(next) {
      if (next) {
        provider.opened()
        for (const observer of [...openObservers]) observer(identity)
      } else provider.closed()
      onOpenChange?.(next)
    },
  })
  const cancelTimer = React.useCallback(() => {
    if (openTimer.current !== null) clearTimeout(openTimer.current)
    openTimer.current = null
  }, [])
  const clearTransit = React.useCallback(() => { setCorridor(null); if (!disableHoverableContent) provider.inTransit.current = false }, [provider.inTransit, disableHoverableContent])
  const close = React.useCallback(() => { cancelTimer(); setOpen(false) }, [cancelTimer, setOpen])
  const immediate = React.useCallback(() => { cancelTimer(); delayedOpen.current = false; setOpen(true) }, [cancelTimer, setOpen])
  const enter = React.useCallback(() => {
    if (!provider.delayed.current) { immediate(); return }
    cancelTimer()
    openTimer.current = setTimeout(() => { delayedOpen.current = true; setOpen(true); openTimer.current = null }, delayDuration ?? provider.delay)
  }, [provider.delayed, provider.delay, delayDuration, immediate, cancelTimer, setOpen])
  const createTransit = React.useCallback((event: React.PointerEvent<HTMLElement>, destination: HTMLElement | null) => {
    if (disableHoverableContent || !destination) return
    setCorridor(transitArea(event, destination))
    provider.inTransit.current = true
  }, [disableHoverableContent, provider.inTransit])
  const leave = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (disableHoverableContent) close()
    else { cancelTimer(); createTransit(event, content) }
  }, [disableHoverableContent, close, cancelTimer, createTransit, content])
  const contentLeave = React.useCallback((event: React.PointerEvent<HTMLElement>) => createTransit(event, trigger), [createTransit, trigger])
  React.useEffect(() => cancelTimer, [cancelTimer])
  React.useEffect(() => {
    if (!corridor) return
    const track = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && (trigger?.contains(target) || content?.contains(target))) clearTransit()
      else if (!containsPoint(corridor, { x: event.clientX, y: event.clientY })) { clearTransit(); close() }
    }
    document.addEventListener("pointermove", track)
    return () => document.removeEventListener("pointermove", track)
  }, [corridor, trigger, content, clearTransit, close])
  React.useEffect(() => () => { if (!disableHoverableContent) provider.inTransit.current = false }, [provider.inTransit, disableHoverableContent])
  const value: TooltipState = { open, state: open ? delayedOpen.current ? "delayed-open" : "instant-open" : "closed", identity,
    trigger, setTrigger, setContent, contentId, setContentId, provider, enter, leave, contentLeave, clearTransit, immediate, close }
  return <Popper.Root><TooltipContext.Provider value={value}>{children}</TooltipContext.Provider></Popper.Root>
}

function setRef<T>(ref: React.Ref<T> | undefined, node: T | null) {
  if (typeof ref === "function") return ref(node)
  if (ref) ref.current = node
}
const TooltipTrigger = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>>(function TooltipTrigger({ asChild, onPointerMove, onPointerLeave, onPointerDown, onFocus, onBlur, onClick, ...props }, forwardedRef) {
  const context = useTooltip()
  const pointerDown = React.useRef(false)
  const pointerMoved = React.useRef(false)
  const { setTrigger } = context
  const ref = React.useCallback((node: HTMLButtonElement | null) => {
    setTrigger(node)
    const cleanup = setRef(forwardedRef, node)
    if (typeof cleanup === "function") return () => { setTrigger(null); cleanup() }
  }, [forwardedRef, setTrigger])
  const pointerUp = React.useCallback(() => { pointerDown.current = false }, [])
  React.useEffect(() => () => document.removeEventListener("pointerup", pointerUp), [pointerUp])
  const Trigger = asChild ? Slot.Root : "button"
  return <Popper.Anchor asChild><Trigger
    data-slot="tooltip-trigger" aria-describedby={context.open ? context.contentId : undefined} data-state={context.state}
    {...props} ref={ref}
    onPointerMove={event => {
      onPointerMove?.(event)
      if (event.defaultPrevented || event.pointerType === "touch") return
      if (!pointerMoved.current && !context.provider.inTransit.current) { context.enter(); pointerMoved.current = true }
    }}
    onPointerLeave={event => { onPointerLeave?.(event); if (!event.defaultPrevented) { context.leave(event); pointerMoved.current = false } }}
    onPointerDown={event => {
      onPointerDown?.(event)
      if (event.defaultPrevented) return
      if (context.open) context.close()
      pointerDown.current = true
      document.addEventListener("pointerup", pointerUp, { once: true })
    }}
    onFocus={event => { onFocus?.(event); if (!event.defaultPrevented && !pointerDown.current) context.immediate() }}
    onBlur={event => { onBlur?.(event); if (!event.defaultPrevented) context.close() }}
    onClick={event => { onClick?.(event); if (!event.defaultPrevented) context.close() }}
  /></Popper.Anchor>
})

type ContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
const ContentSlottable = Slot.createSlottable("PassiveTooltipContent")
const PositionedContent = React.forwardRef<HTMLDivElement, ContentProps>(function PositionedContent({
  className, side = "top", sideOffset = 6, children, "aria-label": ariaLabel, id, style,
  onEscapeKeyDown, onPointerDownOutside, onPointerLeave, forceMount, ...props
}, forwardedRef) {
  const context = useTooltip()
  const { setContent, setContentId, close, identity, trigger, clearTransit } = context
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const latest = React.useRef({ close, onPointerDownOutside })
  React.useLayoutEffect(() => { latest.current = { close, onPointerDownOutside } }, [close, onPointerDownOutside])
  const ref = React.useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node; setContent(node)
    const cleanup = setRef(forwardedRef, node)
    if (typeof cleanup === "function") return () => { contentRef.current = null; setContent(null); cleanup() }
  }, [forwardedRef, setContent])
  // Retain the source-compatible prop type, but passive tooltips never observe
  // Escape. In particular there is no dismissal primitive or keyboard listener.
  void onEscapeKeyDown
  void forceMount
  React.useLayoutEffect(() => { setContentId(id); return () => setContentId() }, [id, setContentId])
  React.useEffect(() => {
    const observer = (opening: object) => { if (opening !== identity) latest.current.close() }
    openObservers.add(observer)
    return () => { openObservers.delete(observer) }
  }, [identity])
  React.useEffect(() => {
    if (!trigger) return
    const scroll = (event: Event) => { if (event.target instanceof Node && event.target.contains(trigger)) latest.current.close() }
    window.addEventListener("scroll", scroll, true)
    return () => window.removeEventListener("scroll", scroll, true)
  }, [trigger])
  React.useEffect(() => {
    let click: (() => void) | null = null
    const removeClick = () => { if (click) document.removeEventListener("click", click); click = null }
    const pointer = (originalEvent: PointerEvent) => {
      removeClick()
      const target = originalEvent.target
      if (!(target instanceof Node) || contentRef.current?.contains(target)) return
      const outside = () => {
        const event = new CustomEvent("tooltip.pointerDownOutside", { cancelable: true, detail: { originalEvent } })
        // Dispatch at the original target so the existing callback receives
        // the normal target/currentTarget and cancellable custom-event API.
        const handler = () => latest.current.onPointerDownOutside?.(event)
        target.addEventListener(event.type, handler, { once: true })
        target.dispatchEvent(event)
        if (!event.defaultPrevented) latest.current.close()
      }
      if (originalEvent.pointerType === "touch") { click = outside; document.addEventListener("click", click, { once: true }) }
      else outside()
    }
    const timer = setTimeout(() => document.addEventListener("pointerdown", pointer), 0)
    return () => { clearTimeout(timer); document.removeEventListener("pointerdown", pointer); removeClick() }
  }, [])
  React.useEffect(() => clearTransit, [clearTransit])
  return <Popper.Content role={ariaLabel ? undefined : "tooltip"} id={ariaLabel ? undefined : context.contentId}
    data-slot="tooltip-content" data-state={context.state} side={side} sideOffset={sideOffset}
    className={cn(
      "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-accent px-2 py-1 text-[11px] text-foreground/85 text-balance fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
      className
    )}
    {...props} ref={ref} onPointerLeave={event => { onPointerLeave?.(event); context.contentLeave(event) }}
    style={{ ...style,
      "--radix-tooltip-content-transform-origin": "var(--radix-popper-transform-origin)",
      "--radix-tooltip-content-available-width": "var(--radix-popper-available-width)",
      "--radix-tooltip-content-available-height": "var(--radix-popper-available-height)",
      "--radix-tooltip-trigger-width": "var(--radix-popper-anchor-width)",
      "--radix-tooltip-trigger-height": "var(--radix-popper-anchor-height)",
    } as React.CSSProperties}>
    <ContentSlottable>{children}</ContentSlottable>
    {ariaLabel && <VisuallyHidden.Root id={context.contentId} role="tooltip">{ariaLabel}</VisuallyHidden.Root>}
  </Popper.Content>
})

const TooltipContent = React.forwardRef<HTMLDivElement, ContentProps>(function TooltipContent({ forceMount, ...props }, forwardedRef) {
  const context = useTooltip()
  const controller = useOptionalInteractionLayers()
  const ownerId = React.useContext(InteractionLayerOwner)
  React.useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.getSnapshot ?? emptySnapshot, emptySnapshot)
  const [body, setBody] = React.useState<HTMLElement | null>(null)
  React.useLayoutEffect(() => { setBody(document.body) }, [])
  const container = body && (controller?.getPortalContainer(context.trigger, controller.ownerOf(context.trigger)?.id ?? ownerId) ?? body)
  if (!container) return null
  return createPortal(<Presence present={!!forceMount || context.open}><PositionedContent {...props} ref={forwardedRef} /></Presence>, container)
})

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
