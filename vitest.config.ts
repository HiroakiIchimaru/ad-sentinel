import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    // テストから実ネットワークへ出さない(広告配信ドメインの URL を使うテストがあるため)
    environmentOptions: {
      happyDOM: {
        settings: {
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
          navigation: { disableChildFrameNavigation: true, disableChildPageNavigation: true },
        },
      },
    },
    include: ["test/**/*.test.ts"],
  },
});
