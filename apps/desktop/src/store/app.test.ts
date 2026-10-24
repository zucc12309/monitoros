import { describe, expect, it } from "vitest";
import { migrateSettings, defaultServiceOpenMode } from "./app";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0";

describe("settings migration", () => {
  it("moves v1 'app-window' (old default) to the platform default", () => {
    expect(migrateSettings({ onboarded: true, serviceOpenMode: "app-window" }, MAC).serviceOpenMode).toBe("in-app");
    expect(migrateSettings({ onboarded: true, serviceOpenMode: "app-window" }, WIN).serviceOpenMode).toBe("app-window");
  });

  it("keeps everything else and marks the settings as migrated", () => {
    const m = migrateSettings({ onboarded: true, region: "IN", subscriptions: ["netflix"], serviceOpenMode: "app-window" }, MAC);
    expect(m).toMatchObject({ onboarded: true, region: "IN", subscriptions: ["netflix"], settingsVersion: 2 });
  });

  it("respects a choice made after migration", () => {
    expect(migrateSettings({ settingsVersion: 2, serviceOpenMode: "app-window" }, MAC).serviceOpenMode).toBe("app-window");
    expect(migrateSettings({ settingsVersion: 2, serviceOpenMode: "browser" }, MAC).serviceOpenMode).toBe("browser");
  });

  it("chooses per-platform defaults", () => {
    expect(defaultServiceOpenMode(MAC)).toBe("in-app");
    expect(defaultServiceOpenMode(WIN)).toBe("app-window");
  });
});
