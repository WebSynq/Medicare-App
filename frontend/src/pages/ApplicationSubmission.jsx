import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { api } from "@/lib/api";

const PRODUCTS = [
  { value: "medsupp", label: "Medicare Supplement" },
  { value: "ma", label: "Medicare Advantage" },
  { value: "pdp", label: "Prescription Drug Plan" },
  { value: "cancer", label: "Cancer" },
  { value: "hs", label: "Heart/Stroke" },
  { value: "hip", label: "Hospital Indemnity" },
  { value: "rc", label: "Recovery Care" },
  { value: "dvh", label: "Dental/Vision/Hearing" },
  { value: "life", label: "Life / Final Expense" },
  { value: "annuity", label: "Annuity" },
];

function contactDisplay(c) {
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return name || c.name || c.email || c.id;
}

export default function ApplicationSubmission() {
  const [contactQuery, setContactQuery] = useState("");
  const [contacts, setContacts] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedContact, setSelectedContact] = useState(null);

  const [productType, setProductType] = useState("");
  const [file, setFile] = useState(null);
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState(null);
  const [productLabel, setProductLabel] = useState("");
  const [fieldsAvailable, setFieldsAvailable] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const q = contactQuery.trim();
    if (q.length < 2) {
      setContacts([]);
      return;
    }
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await api.get("/applications/search-contacts", {
          params: { query: q },
        });
        setContacts(data.contacts || []);
      } catch (err) {
        const detail =
          err?.response?.data?.detail || err?.message || "Search failed";
        toast.error(detail);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [contactQuery]);

  const canExtract =
    !!selectedContact && !!productType && !!file && !extracting;

  const filledCount = useMemo(() => {
    if (!extracted) return 0;
    return Object.values(extracted).filter(
      (v) => v !== null && v !== undefined && String(v).trim() !== ""
    ).length;
  }, [extracted]);

  async function handleExtract() {
    if (!canExtract) return;
    const fd = new FormData();
    fd.append("file", file);
    fd.append("product_type", productType);
    setExtracting(true);
    setSubmitted(false);
    try {
      const { data } = await api.post("/applications/extract", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setExtracted(data.extracted || {});
      setProductLabel(data.product_label || "");
      setFieldsAvailable(data.fields_available || []);
      toast.success(`Extracted ${data.field_count} field(s) from PDF`);
    } catch (err) {
      const detail =
        err?.response?.data?.detail || err?.message || "Extraction failed";
      toast.error(detail);
    } finally {
      setExtracting(false);
    }
  }

  function updateField(key, value) {
    setExtracted((prev) => ({ ...prev, [key]: value === "" ? null : value }));
  }

  async function handleSubmit() {
    if (!selectedContact || !extracted) return;
    setSubmitting(true);
    try {
      const { data } = await api.post("/applications/submit", {
        contact_id: selectedContact.id,
        product_type: productType,
        extracted,
        contact_name: contactDisplay(selectedContact),
      });
      toast.success(
        `Submitted ${data.fields_synced} field(s) to GHL${
          data.ghl_mock ? " (mock mode)" : ""
        }`
      );
      setSubmitted(true);
    } catch (err) {
      const detail =
        err?.response?.data?.detail || err?.message || "Submit failed";
      toast.error(detail);
    } finally {
      setSubmitting(false);
    }
  }

  function resetForm() {
    setFile(null);
    setExtracted(null);
    setSubmitted(false);
    setProductLabel("");
    setFieldsAvailable([]);
  }

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1100px] w-full mx-auto">
        <div className="mb-6">
          <h1
            className="text-2xl font-semibold tracking-tight"
            style={{ fontFamily: "Outfit" }}
          >
            Submit Application
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload a signed insurance application PDF. AI extracts the fields,
            you confirm, and we push to the GoHighLevel contact.
          </p>
        </div>

        <div className="grid lg:grid-cols-3 gap-5">
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle className="text-base">1. Find contact</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Label htmlFor="contact-search">Search by name or email</Label>
              <Input
                id="contact-search"
                placeholder="At least 2 characters"
                value={contactQuery}
                onChange={(e) => setContactQuery(e.target.value)}
                data-testid="contact-search-input"
              />
              {searching && (
                <p className="text-xs text-muted-foreground">Searching…</p>
              )}
              <div className="max-h-72 overflow-auto space-y-1">
                {contacts.map((c) => {
                  const isSelected = selectedContact?.id === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedContact(c)}
                      className={`w-full text-left px-3 py-2 rounded-md border text-sm transition ${
                        isSelected
                          ? "border-[#e85d2f] bg-[#e85d2f]/5"
                          : "border-border hover:bg-secondary"
                      }`}
                      data-testid={`contact-option-${c.id}`}
                    >
                      <div className="font-medium">{contactDisplay(c)}</div>
                      {c.email && (
                        <div className="text-xs text-muted-foreground">
                          {c.email}
                        </div>
                      )}
                    </button>
                  );
                })}
                {!searching &&
                  contactQuery.trim().length >= 2 &&
                  contacts.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No matches.
                    </p>
                  )}
              </div>
              {selectedContact && (
                <div className="mt-3 p-3 rounded-md bg-secondary text-sm">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                    Selected
                  </div>
                  <div className="font-medium">
                    {contactDisplay(selectedContact)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {selectedContact.id}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">
                2. Upload and extract
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="product-type">Product type</Label>
                  <Select value={productType} onValueChange={setProductType}>
                    <SelectTrigger
                      id="product-type"
                      data-testid="product-type-select"
                    >
                      <SelectValue placeholder="Select product" />
                    </SelectTrigger>
                    <SelectContent>
                      {PRODUCTS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="pdf">Signed application (PDF, max 20MB)</Label>
                  <Input
                    id="pdf"
                    type="file"
                    accept="application/pdf"
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                    data-testid="pdf-input"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  onClick={handleExtract}
                  disabled={!canExtract}
                  data-testid="extract-btn"
                >
                  {extracting ? "Extracting…" : "Extract fields with AI"}
                </Button>
                {extracted && (
                  <Button
                    variant="outline"
                    onClick={resetForm}
                    data-testid="reset-btn"
                  >
                    Reset
                  </Button>
                )}
                {productLabel && (
                  <Badge variant="secondary" className="ml-auto">
                    {productLabel}
                  </Badge>
                )}
              </div>

              {extracted && (
                <div className="space-y-3 pt-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">
                      3. Review and edit ({filledCount} of{" "}
                      {fieldsAvailable.length || Object.keys(extracted).length}{" "}
                      populated)
                    </h3>
                  </div>
                  <div className="grid md:grid-cols-2 gap-3">
                    {(fieldsAvailable.length
                      ? fieldsAvailable
                      : Object.keys(extracted)
                    ).map((key) => (
                      <div key={key}>
                        <Label
                          htmlFor={`fld-${key}`}
                          className="text-[11px] uppercase tracking-wider text-muted-foreground"
                        >
                          {key}
                        </Label>
                        <Input
                          id={`fld-${key}`}
                          value={
                            extracted[key] === null ||
                            extracted[key] === undefined
                              ? ""
                              : String(extracted[key])
                          }
                          onChange={(e) => updateField(key, e.target.value)}
                          placeholder="—"
                          data-testid={`fld-${key}`}
                        />
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-3 border-t">
                    {submitted && (
                      <span className="text-sm text-green-700">
                        Pushed to GHL ✓
                      </span>
                    )}
                    <Button
                      onClick={handleSubmit}
                      disabled={!selectedContact || submitting || submitted}
                      data-testid="submit-btn"
                    >
                      {submitting
                        ? "Submitting…"
                        : submitted
                          ? "Submitted"
                          : "Submit to GoHighLevel"}
                    </Button>
                  </div>
                  {!selectedContact && (
                    <p className="text-xs text-muted-foreground text-right">
                      Pick a contact in step 1 before submitting.
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
