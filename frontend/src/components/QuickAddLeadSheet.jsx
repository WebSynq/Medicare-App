import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { api } from "@/lib/api";

const EMPTY = {
  first_name: "",
  last_name: "",
  email: "",
  phone: "",
  date_of_birth: "",
  notes: "",
};

// Verbatim consent paragraph shown next to the checkbox. Sent to the
// server alongside the boolean so /api/compliance/export/tcpa.csv can
// prove exactly what the contact agreed to at sign-up time, even if we
// reword the prompt later.
export const TCPA_CONSENT_TEXT =
  "I agree to receive text messages and marketing communications from " +
  "Gruening Health & Wealth regarding Medicare insurance options. " +
  "Message & data rates may apply. Reply STOP to opt out at any time.";

// Quick-add lead drawer. Lives in /components so both ClientsList and
// the AgentDashboard header can mount the same form; previously it was
// defined inline on ClientsList, which left the dashboard with no path
// to create a lead except via the standalone /intake flow.
export default function QuickAddLeadSheet({ open, onOpenChange, onCreated }) {
  const [form, setForm] = useState(EMPTY);
  const [tcpa, setTcpa] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.first_name.trim() || !form.last_name.trim()) {
      toast.error("First and last name are required.");
      return;
    }
    if (!tcpa) {
      // Belt + suspenders — button is also disabled, but a determined
      // user could submit via Enter; the server doesn't enforce consent
      // (some leads come from offline channels), so we enforce on the
      // UI surface that owns the explicit checkbox interaction.
      toast.error("Please confirm TCPA consent to continue.");
      return;
    }
    setSubmitting(true);
    try {
      const payload = Object.fromEntries(
        Object.entries(form).filter(([_, v]) => v !== "" && v !== null),
      );
      payload.tcpa_consent = true;
      payload.tcpa_consent_text = TCPA_CONSENT_TEXT;
      const { data } = await api.post("/leads", payload);
      toast.success(`Created ${data.first_name} ${data.last_name}`);
      setForm(EMPTY);
      setTcpa(false);
      onCreated?.(data);
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || err?.message || "Create failed",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto" data-testid="new-client-sheet">
        <SheetHeader>
          <SheetTitle>New lead</SheetTitle>
          <SheetDescription>
            Quick intake. You can fill in the rest from the client profile.
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-4 px-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="nc-first">First name *</Label>
              <Input
                id="nc-first"
                value={form.first_name}
                onChange={(e) => update("first_name", e.target.value)}
                required
                data-testid="new-client-first"
              />
            </div>
            <div>
              <Label htmlFor="nc-last">Last name *</Label>
              <Input
                id="nc-last"
                value={form.last_name}
                onChange={(e) => update("last_name", e.target.value)}
                required
                data-testid="new-client-last"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="nc-email">Email</Label>
            <Input
              id="nc-email"
              type="email"
              value={form.email}
              onChange={(e) => update("email", e.target.value)}
              data-testid="new-client-email"
            />
          </div>
          <div>
            <Label htmlFor="nc-phone">Phone</Label>
            <Input
              id="nc-phone"
              type="tel"
              value={form.phone}
              onChange={(e) => update("phone", e.target.value)}
              data-testid="new-client-phone"
            />
          </div>
          <div>
            <Label htmlFor="nc-dob">Date of birth</Label>
            <Input
              id="nc-dob"
              type="date"
              value={form.date_of_birth}
              onChange={(e) => update("date_of_birth", e.target.value)}
              data-testid="new-client-dob"
            />
          </div>
          <div>
            <Label htmlFor="nc-notes">Notes</Label>
            <Textarea
              id="nc-notes"
              rows={4}
              value={form.notes}
              onChange={(e) => update("notes", e.target.value)}
              data-testid="new-client-notes"
            />
          </div>

          <label
            className="flex items-start gap-2 rounded-md border border-border bg-secondary/30 p-3 cursor-pointer"
            data-testid="new-client-tcpa-row"
          >
            <input
              type="checkbox"
              className="mt-0.5 accent-[#e85d2f]"
              checked={tcpa}
              onChange={(e) => setTcpa(e.target.checked)}
              required
              data-testid="new-client-tcpa-checkbox"
            />
            <span className="text-[11px] leading-snug text-foreground/80">
              {TCPA_CONSENT_TEXT}
            </span>
          </label>

          <SheetFooter className="px-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || !tcpa}
              data-testid="new-client-submit"
            >
              {submitting ? "Creating…" : "Create lead"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
