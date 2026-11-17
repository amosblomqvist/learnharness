"use client";

import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { useDisclosure } from "@/components/disclosure-store";
import { useAppearance } from "@/components/settings/appearance";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import { BrailleSpinner } from "@/components/braille-spinner";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";

import { transformMathDelimiters } from "@/src/core";
import { streamdownPlugins, streamdownRehypePlugins, streamdownRemend } from "./message";
import { mdComponents } from "@/components/md-blocks";
import { Shimmer } from "./shimmer";

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = Omit<ComponentProps<typeof Collapsible>, "defaultOpen"> & {
  isStreaming?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

const AUTO_CLOSE_DELAY = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    onOpenChange,
    children,
    ...props
  }: ReasoningProps) => {
    // The row starts at the Agent thinking setting (factory: collapsed)
    // and never auto-opens on streaming (owner, streaming round
    // 2026-10-01): an auto-open effect re-fought a manual collapse, so
    // the block "wasn't collapsible until it finished".
    const [ownOpen, setOwnOpen] = useDisclosure("agentThinking");
    const expandByDefault = useAppearance().appearance.expandByDefault.agentThinking;
    const isOpen = open ?? ownOpen;
    const setIsOpen = useCallback(
      (next: boolean) => {
        setOwnOpen(next);
        onOpenChange?.(next);
      },
      [setOwnOpen, onOpenChange]
    );
    const hasEverStreamedRef = useRef(isStreaming);
    const [hasAutoClosed, setHasAutoClosed] = useState(false);

    // Auto-close when streaming ends (once only, and only if it ever
    // streamed) tidies a row the learner opened. With the setting on it
    // would undo the setting, so it stays open.
    useEffect(() => {
      if (
        !expandByDefault &&
        hasEverStreamedRef.current &&
        !isStreaming &&
        isOpen &&
        !hasAutoClosed
      ) {
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);

        return () => clearTimeout(timer);
      }
    }, [expandByDefault, isStreaming, isOpen, setIsOpen, hasAutoClosed]);

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        setIsOpen(newOpen);
      },
      [setIsOpen]
    );

    const contextValue = useMemo(
      () => ({ isOpen, isStreaming, setIsOpen }),
      [isOpen, isStreaming, setIsOpen]
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("not-prose mb-4", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  }
);

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isStreaming: boolean) => ReactNode;
};

/* The settled label (owner round, 2026-10-05): static "Agent's thinking" —
   the duration was live-turn state that died on remount anyway ("thought
   for a few seconds"), bookkeeping for information we knowingly lose. The
   label pairs with the user's collapsed "Your thinking" rows — one
   language; motion (spinner + shimmer) stays the working signal. */
const defaultGetThinkingMessage = (isStreaming: boolean) => {
  if (isStreaming) {
    return <Shimmer duration={1}>Thinking...</Shimmer>;
  }
  return <p>AGENT’S THINKING</p>;
};

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          /* The heading register (owner round 4, 2026-10-05): the small
             mono caps of the card eyebrows — matching YOUR THINKING, whose
             rail offsets it by exactly the one-character difference. */
          "flex w-full items-center gap-2 text-muted-foreground text-xs font-medium uppercase tracking-wide transition-colors hover:text-foreground",
          className
        )}
        {...props}
        /* FOCUS HYGIENE (owner, keyboard round 2026-10-10): a pointer click
           on the thinking toggle must not leave focus here — the learner's
           next Enter submits, it must not re-toggle. Radix composes this
           with its own toggle handler. */
        onClick={(e) => blurAfterPointerClick(e)}
      >
        {children ?? (
          <>
            {/* The working-state grammar (owner, streaming round
                2026-10-01): the Braille spinner replaces the brain icon
                WHILE STREAMING ONLY — motion is the signal, so a finished
                row carries no icon at all, just text + chevron. Size:
                the component default (h-3) — IDENTICAL to the placeholder
                spinner (owner, 2026-10-02): the handoff between the two
                states must be visually seamless, one size everywhere. */}
            {isStreaming && <BrailleSpinner label="Thinking" />}
            {getThinkingMessage(isStreaming)}
            <ChevronDownIcon
              className={cn(
                "size-4 transition-transform",
                isOpen ? "rotate-180" : "rotate-0"
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  }
);

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};

// Shares message.tsx's Streamdown config (math delimiters, dark mermaid,
// remark-breaks) — reasoning renders the same contract as message text.

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => (
    <CollapsibleContent
      className={cn(
        "mt-4 text-sm",
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        className
      )}
      {...props}
    >
      <Streamdown components={mdComponents} plugins={streamdownPlugins} rehypePlugins={streamdownRehypePlugins} remend={streamdownRemend}>
        {transformMathDelimiters(children)}
      </Streamdown>
    </CollapsibleContent>
  )
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
