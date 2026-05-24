import { useState } from "react";
import { useLocation } from "react-router-dom";
import { MessageSquare, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Floating feedback button. Mounted once inside AppLayout — visible on
 * every authenticated page. Opens a small dialog with a single textarea
 * that POSTs to /api/feedback (which fans the payload out to the GHL
 * feedback workflow and writes an audit row regardless of outcome).
 *
 * Positioning notes:
 *  - Desktop: bottom-right, lifted ABOVE the ChatWidget FAB
 *    (`md:bottom-24 md:right-6`). ChatWidget anchors at bottom-5 — we
 *    clear it with a ~20px gap.
 *  - Mobile: lifted further so it clears both the ChatWidget bubble
 *    AND the persistent MobileTabBar (`bottom-28 right-4`).
 */
export default function FeedbackButton() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const trimmed = message.trim();
  const disabled = submitting || trimmed.length === 0;

  async function handleSubmit() {
    if (disabled) return;
    setSubmitting(true);
    try {
      await api.post("/feedback", {
        message: trimmed,
        // Captured server-stamp-free so the team sees exactly where the
        // agent was when they hit the button (not where they navigated
        // to between click and submit — useLocation re-renders on nav).
        page_url: location.pathname + location.search,
      });
      toast.success("Thanks — the team will take a look.");
      setMessage("");
      setOpen(false);
    } catch (err) {
      const detail =
        err?.response?.data?.detail ||
        err?.message ||
        "Couldn't send feedback. Please try again.";
      toast.error(detail);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="feedback-button"
        aria-label="Send feedback"
        className="fixed z-50 rounded-full shadow-lg elev-2 px-4 h-12
                   bottom-28 right-4
                   md:bottom-24 md:right-6"
        style={{ backgroundColor: "#e85d2f" }}
      >
        <MessageSquare className="w-4 h-4 mr-2" />
        <span className="hidden sm:inline">Feedback</span>
      </Button>

      <Dialog open={open} onOpenChange={(v) => !submitting && setOpen(v)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send feedback</DialogTitle>
            <DialogDescription>
              Tell the team what's working, what's broken, or what you wish
              the portal could do. Goes straight to the product team — they
              see your name, the page you're on, and the build you're using.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What's on your mind?"
            rows={6}
            maxLength={4000}
            autoFocus
            disabled={submitting}
            data-testid="feedback-textarea"
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter to submit — common form-affordance.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <div className="text-xs text-muted-foreground -mt-2">
            {trimmed.length}/4000
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={disabled}
              data-testid="feedback-submit"
            >
              {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {submitting ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
