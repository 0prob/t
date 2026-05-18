import { describe, it, expect } from "vitest";
import { Counter, Gauge, Histogram, renderMetrics } from "./metrics.ts";

describe("metrics", () => {
  it("counter increments", () => {
    const c = new Counter({ name: "test_counter", help: "test description" });
    c.inc();
    c.inc(5);
    const rendered = renderMetrics();
    expect(rendered).toContain("test_counter");
    expect(rendered).toContain("6");
  });

  it("gauge sets value", () => {
    const g = new Gauge({ name: "test_gauge", help: "test description" });
    g.set(42);
    const rendered = renderMetrics();
    expect(rendered).toContain("test_gauge");
    expect(rendered).toContain("42");
  });

  it("histogram observes values", () => {
    const h = new Histogram({ name: "test_hist", help: "test description", buckets: [1, 5, 10, 50, 100] });
    h.observe(3);
    h.observe(7);
    h.observe(25);
    const rendered = renderMetrics();
    expect(rendered).toContain("test_hist");
    expect(rendered).toContain("test_hist_count");
  });
});
