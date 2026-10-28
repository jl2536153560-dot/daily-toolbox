import { describe, expect, it, vi } from "vitest";
import { collectComments, normalizePreferences, type CollectionDriver, type CollectionPageState } from "../src/content/collection";
import type { ScanResult } from "../src/shared/types";

function result(count: number): ScanResult { return { comments: Array.from({ length: count }, (_, id) => ({ id: String(id) })) } as ScanResult; }
function page(overrides: Partial<CollectionPageState> = {}): CollectionPageState {
  return { available: true, loading: false, atEnd: false, atBottom: false, position: 0, extent: 1000, ...overrides };
}
function driver(overrides: Partial<CollectionDriver> = {}): CollectionDriver {
  let elapsed = 0;
  return { target: 100, signal: new AbortController().signal, identity: () => "video-A", blocked: () => false,
    scan: () => result(10), scroll: () => true, progress: () => {}, pageState: () => page(), now: () => elapsed, ...overrides,
    wait: async () => { elapsed += 1500; await overrides.wait?.(); }
  };
}
describe("automatic comment collection", () => {
  it("stops at the target without extra scrolling", async () => {
    const scroll = vi.fn(() => true); let reads = 0;
    const output = await collectComments(driver({ scan: () => result(++reads * 50), scroll }));
    expect(output.reason).toBe("target"); expect(output.scan?.comments).toHaveLength(100); expect(scroll).toHaveBeenCalledTimes(1);
  });
  it("waits for a slow loading batch beyond the old five-round timeout", async () => {
    let ticks = 0; const scroll = vi.fn(() => true);
    const output = await collectComments(driver({
      pageState: () => page({loading: ticks > 0 && ticks < 12, atBottom: true}),
      scan: () => result(ticks < 12 ? 10 : 100), scroll, wait: async () => { ticks += 1; }
    }));
    expect(output.reason).toBe("target"); expect(ticks).toBe(12); expect(scroll).toHaveBeenCalledTimes(1);
  });
  it("scrolls toward a lazy loading placeholder before waiting at its bottom", async () => {
    let ticks = 0; let atBottom = false;
    const scroll = vi.fn(() => { atBottom = true; return true; });
    const output = await collectComments(driver({
      pageState: () => page({loading:ticks < 4,atBottom,position:atBottom ? 800 : 0}),
      scan: () => result(atBottom && ticks >= 4 ? 100 : 18), scroll,
      wait: async () => { ticks += 1; }
    }));
    expect(output.reason).toBe("target"); expect(ticks).toBe(4);
    expect(scroll).toHaveBeenCalledTimes(1);
  });
  it("only infers completion after a stable bottom with no loading indicator", async () => {
    const scroll = vi.fn(() => true); const output = await collectComments(driver({ pageState: () => page({atBottom:true}), scroll }));
    expect(output.reason).toBe("end"); expect(scroll).toHaveBeenCalledTimes(20); expect(output.scan?.comments).toHaveLength(10);
  });
  it("does not mistake quiet counts while progressing through cached comments for the end", async () => {
    let ticks = 0;
    const output = await collectComments(driver({
      target: 1000, scan: () => result(101), pageState: () => page({position: ticks * 400, atEnd: ticks === 100}),
      wait: async () => { ticks += 1; }
    }));
    expect(output.reason).toBe("end"); expect(ticks).toBe(100);
  });
  it("returns a recoverable pause, not completion, when the page has no end evidence", async () => {
    const output = await collectComments(driver());
    expect(output.reason).toBe("paused"); expect(output.scan?.comments).toHaveLength(10);
  });
  it("pauses a spinner that never finishes without declaring all comments collected", async () => {
    const scroll = vi.fn(() => true);
    const output = await collectComments(driver({pageState:()=>page({loading:true,atBottom:true,atEnd:true}),scroll}));
    expect(output.reason).toBe("paused"); expect(scroll).not.toHaveBeenCalled();
  });
  it("resets the bottom settlement timer when a new batch grows the page", async () => {
    let ticks = 0;
    const output = await collectComments(driver({
      pageState: () => page({atBottom:true,extent:ticks >= 10 ? 2000 : 1000}),
      wait: async () => { ticks += 1; }
    }));
    expect(output.reason).toBe("end"); expect(ticks).toBe(30);
  });
  it("reads the final visible batch before honoring an explicit end marker", async () => {
    const scan = vi.fn(() => result(28)); const scroll = vi.fn(() => true);
    const output = await collectComments(driver({pageState:()=>page({atEnd:true}),scan,scroll}));
    expect(output.reason).toBe("end"); expect(output.scan?.comments).toHaveLength(28);
    expect(scan).toHaveBeenCalledTimes(1); expect(scroll).not.toHaveBeenCalled();
  });
  it("caps the run even while counts keep growing", async () => {
    let count = 0; const output = await collectComments(driver({ scan: () => result(++count), maxRounds: 3 }));
    expect(output.reason).toBe("round-limit"); expect(count).toBe(4);
  });
  it("can reach 100000 without stopping at the former 180-scroll cap", async () => {
    let count = 0; const scroll = vi.fn(() => true);
    // Sparse arrays exercise the count boundary without allocating millions of fixtures.
    const output = await collectComments(driver({ target: 100000, scan: () => ({ comments: new Array(Math.min(100000, count += 500)) }) as ScanResult, scroll }));
    expect(output.reason).toBe("target"); expect(output.scan?.comments).toHaveLength(100000);
    expect(scroll).toHaveBeenCalledTimes(199);
  });
  it("clamps an out-of-range driver target to the 100000 maximum", async () => {
    const scroll = vi.fn(() => true);
    const output = await collectComments(driver({ target: 200000, scan: () => ({comments: new Array(100000)}) as ScanResult, scroll }));
    expect(output.reason).toBe("target"); expect(scroll).not.toHaveBeenCalled();
  });
  it("does not scan a new video's DOM when SPA navigation happens during a wait", async () => {
    let identity = "A"; const scan = vi.fn(() => result(10));
    const output = await collectComments(driver({ identity: () => identity, scan, wait: async () => { identity = "B"; } }));
    expect(output.reason).toBe("video-changed"); expect(output.scan).toBeNull(); expect(scan).toHaveBeenCalledTimes(1);
  });
  it("preserves partial data on user cancellation without another scan", async () => {
    const controller = new AbortController(); const scan = vi.fn(() => result(10));
    const output = await collectComments(driver({ signal: controller.signal, scan, wait: async () => controller.abort() }));
    expect(output.reason).toBe("cancelled"); expect(output.scan?.comments).toHaveLength(10); expect(scan).toHaveBeenCalledTimes(1);
  });
  it("awaits durable progress and honors cancellation before declaring the target complete", async () => {
    const controller = new AbortController(); const scroll = vi.fn(() => true);
    let release!: () => void;
    const saved = new Promise<void>(resolve => { release = resolve; });
    const output = collectComments(driver({signal:controller.signal,scan:()=>result(100),scroll,progress:()=>saved}));
    controller.abort(); release();
    expect((await output).reason).toBe("cancelled"); expect(scroll).not.toHaveBeenCalled();
  });
  it("does not return the old video's data when navigation occurs during progress persistence", async () => {
    let identity = "A"; let release!: () => void; const scroll = vi.fn(() => true);
    const saved = new Promise<void>(resolve => { release = resolve; });
    const output = collectComments(driver({identity:()=>identity,scan:()=>result(100),scroll,progress:()=>saved}));
    identity = "B"; release();
    expect(await output).toMatchObject({reason:"video-changed",scan:null}); expect(scroll).not.toHaveBeenCalled();
  });
  it("does not scroll if the tab becomes hidden while progress is being saved", async () => {
    const controller = new AbortController(); const scroll = vi.fn(() => true); let hidden = false;
    const output = await collectComments(driver({signal:controller.signal,scroll,suspended:()=>hidden,
      progress:async()=>{hidden=true;},wait:async()=>controller.abort()}));
    expect(output.reason).toBe("cancelled"); expect(scroll).not.toHaveBeenCalled();
  });
  it("stops before scrolling or reading when login or captcha appears", async () => {
    const scan = vi.fn(() => result(10)); const scroll = vi.fn(() => true);
    const output = await collectComments(driver({ blocked: () => true, scan, scroll }));
    expect(output.reason).toBe("blocked"); expect(scan).not.toHaveBeenCalled(); expect(scroll).not.toHaveBeenCalled();
  });
  it("waits through a temporarily replaced comment region without scanning unrelated DOM", async () => {
    let ticks = 0; const scan = vi.fn(() => result(ticks >= 12 ? 100 : 10)); const scroll = vi.fn(() => true);
    const output = await collectComments(driver({
      pageState: () => page({available: ticks === 0 || ticks >= 12}), scan, scroll,
      wait: async () => { ticks += 1; }
    }));
    expect(output.reason).toBe("target"); expect(scan).toHaveBeenCalledTimes(2); expect(scroll).toHaveBeenCalledTimes(1);
  });
  it("retries a scroll region that cannot currently scroll instead of stopping immediately", async () => {
    let ticks = 0; const scroll = vi.fn(() => ticks >= 7);
    const output = await collectComments(driver({scroll,scan:()=>result(ticks >= 8 ? 100 : 10),wait:async()=>{ticks+=1;}}));
    expect(output.reason).toBe("target"); expect(scroll).toHaveBeenCalledTimes(8);
  });
  it("keeps partial data when a missing region does not recover", async () => {
    let ticks = 0; const scan = vi.fn(() => result(10));
    const output = await collectComments(driver({pageState:()=>page({available:ticks===0}),scan,wait:async()=>{ticks+=1;}}));
    expect(output.reason).toBe("paused"); expect(output.scan?.comments).toHaveLength(10); expect(scan).toHaveBeenCalledTimes(1);
  });
  it("background suspension consumes neither end settlement time nor idle timeout", async () => {
    let ticks = 0; const scan = vi.fn(() => result(10)); const scroll = vi.fn(() => true);
    const output = await collectComments(driver({
      pageState:()=>page({atBottom:true}), suspended:()=>ticks>=1 && ticks<101, scan, scroll,
      wait:async()=>{ticks+=1;}
    }));
    expect(output.reason).toBe("end"); expect(ticks).toBeGreaterThanOrEqual(120);
    expect(scroll.mock.calls.length).toBeGreaterThanOrEqual(20); expect(scan.mock.calls.length).toBeLessThan(25);
  });
  it("can be cancelled while suspended without another page scan", async () => {
    const controller = new AbortController(); const scan = vi.fn(() => result(10));
    const output=await collectComments(driver({signal:controller.signal,suspended:()=>true,scan,wait:async()=>controller.abort()}));
    expect(output.reason).toBe("cancelled"); expect(scan).not.toHaveBeenCalled();
  });
  it("normalizes stored preferences and never enables automatic collection by default", () => {
    expect(normalizePreferences(undefined)).toEqual({ target: 100000, autoStart: false });
    expect(normalizePreferences({ target: 99999, autoStart: true })).toEqual({ target: 100000, autoStart: true });
    expect(normalizePreferences({ target: 1000, autoStart: false })).toEqual({ target: 1000, autoStart: false });
    expect(normalizePreferences({ target: 100000, autoStart: false })).toEqual({ target: 100000, autoStart: false });
    expect(normalizePreferences({ target: 100001, autoStart: true })).toEqual({ target: 100000, autoStart: true });
  });
});
