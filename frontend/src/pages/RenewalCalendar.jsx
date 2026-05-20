import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarClock, Phone } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import ScrollableCard from "@/components/ScrollableCard";
import ImpersonationBanner from "@/components/ImpersonationBanner";

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function productMatches(filter, p) {
  if (filter === "all") return true;
  const t = (p.product_type || p.product_label || "").toString().toLowerCase();
  if (filter === "ma")
    return ["ma", "medicare advantage", "medicare_advantage"].includes(t);
  if (filter === "pdp")
    return ["pdp", "prescription drug plan", "prescription_drug"].includes(t);
  if (filter === "medsupp")
    return ["med_supp", "medsupp", "medicare supplement", "med supp"].includes(t);
  return true;
}

export default function RenewalCalendar() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [productFilter, setProductFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/renewals/alerts");
      setData(data);
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || "Could not load renewals",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    return (data?.renewal_alerts || []).filter((p) =>
      productMatches(productFilter, p),
    );
  }, [data, productFilter]);

  const aep = data?.aep_countdown || {};
  const oep = data?.oep_countdown || {};

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <CalendarClock className="w-4 h-4 text-[#e85d2f]" />
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Calendar
              </p>
            </div>
            <h1
              className="text-2xl font-bold tracking-tight"
              style={{ fontFamily: "Outfit" }}
            >
              Renewal Calendar
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Policy anniversaries inside the next 90 days plus AEP and
              OEP countdowns.
            </p>
            <ImpersonationBanner />
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>

        {/* AEP / OEP countdown cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <CountdownCard
            title="Annual Enrollment Period"
            window="Oct 15 – Dec 7"
            daysUntil={aep.days_until}
            isActive={aep.is_active}
            label="AEP"
          />
          <CountdownCard
            title="Open Enrollment Period"
            window="Jan 1 – Mar 31"
            daysUntil={oep.days_until}
            isActive={oep.is_active}
            label="OEP"
          />
        </div>

        <Card className="bg-surface mb-3">
          <CardContent className="p-4 flex flex-wrap items-center gap-3">
            <div className="text-xs text-muted-foreground">
              MA clients on file:{" "}
              <span className="font-semibold text-foreground">
                {data?.total_ma_clients ?? 0}
              </span>
              {" · "}PDP:{" "}
              <span className="font-semibold text-foreground">
                {data?.total_pdp_clients ?? 0}
              </span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Filter</span>
              <Select value={productFilter} onValueChange={setProductFilter}>
                <SelectTrigger
                  className="w-44 h-9"
                  data-testid="renewals-product-filter"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All products</SelectItem>
                  <SelectItem value="ma">Medicare Advantage</SelectItem>
                  <SelectItem value="pdp">Prescription Drug Plan</SelectItem>
                  <SelectItem value="medsupp">Medicare Supplement</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <ScrollableCard
          title="Upcoming Renewals"
          count={rows.length}
          height="calc(100vh - 480px)"
          loading={loading}
          isEmpty={!loading && rows.length === 0}
          emptyState="No renewals in the next 90 days for this filter."
          testId="renewals-card"
        >
          <div className="overflow-x-auto w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Carrier</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead>Renewal</TableHead>
                  <TableHead className="text-right">Days Until</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow
                    key={r.lead_id || `${r.full_name}-${i}`}
                    data-testid={`renewal-row-${r.lead_id || i}`}
                  >
                    <TableCell className="font-medium text-sm">
                      {r.full_name || "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.product_label || r.product_type || "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.carrier || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {fmtDate(r.effective_date)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {fmtDate(r.renewal_date)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm font-semibold">
                      {r.days_until_renewal}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-2">
                        {r.lead_id && (
                          <Button
                            asChild
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                          >
                            <Link to={`/clients/${r.lead_id}`}>
                              <Phone className="w-3 h-3 mr-1" />
                              Contact
                            </Link>
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </ScrollableCard>
      </main>
    </div>
  );
}

function CountdownCard({ title, window, daysUntil, isActive, label }) {
  return (
    <Card
      className={`bg-surface ${isActive ? "border-[#e85d2f]/60" : ""}`}
      data-testid={`countdown-${label.toLowerCase()}`}
    >
      <CardContent className="p-4 flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
            {title}
          </div>
          <div className="text-sm font-semibold mt-0.5">{window}</div>
        </div>
        {isActive ? (
          <Badge
            className="rounded-full border-0 text-white animate-pulse"
            style={{
              background:
                "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
            }}
          >
            {label} ACTIVE
          </Badge>
        ) : (
          <div className="text-right">
            <div
              className="text-2xl font-bold tabular-nums"
              style={{ fontFamily: "Outfit" }}
            >
              {daysUntil ?? "—"}
            </div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              days until {label}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
