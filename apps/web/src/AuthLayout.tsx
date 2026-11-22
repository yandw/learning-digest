import type { ReactNode } from "react";
import type { ThemeConfig } from "antd";

/* UI v2 · design tokens — warm paper + ink + ultramarine (design/v2 board B0) */
export const libraryTheme: ThemeConfig = {
  token: {
    colorPrimary: "#3D53E7",
    colorInfo: "#3D53E7",
    colorError: "#D24A3E",
    colorSuccess: "#2F9E68",
    colorWarning: "#E39B2D",
    colorText: "#1B1812",
    colorTextSecondary: "#5D574A",
    colorTextTertiary: "#9A937F",
    colorTextPlaceholder: "#9A937F",
    colorBgLayout: "#FAF8F3",
    colorBgContainer: "#FFFFFF",
    colorBgElevated: "#FFFFFF",
    colorBorder: "#E8E3D7",
    colorBorderSecondary: "#E8E3D7",
    colorFillQuaternary: "#F3F0E8",
    fontSize: 15,
    borderRadius: 10,
    fontFamily:
      '"Inter", -apple-system, "Segoe UI", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif',
  },
  components: {
    Switch: { colorPrimary: "#3D53E7", colorPrimaryHover: "#2C3EC4" },
    Tabs: { inkBarColor: "#3D53E7", itemSelectedColor: "#1B1812" },
  },
};

export default function AuthLayout({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  return (
    <main className="login-shell">
      <div className="auth-brand-panel" aria-hidden="true">
        <div className="auth-brand-top">
          <span className="wordmark">
            <i aria-hidden="true" />
            Learning Digest
          </span>
        </div>
        <div className="auth-brand-middle">
          <p className="auth-tagline">
            Every lesson,
            <br />
            digested.
          </p>
          <span className="auth-rule" aria-hidden="true" />
          <ul className="auth-features">
            <li>— 逐段转写，边学边看</li>
            <li>— 时间戳笔记，一键回溯原文</li>
            <li>— AI 总结与引用，可验证</li>
          </ul>
        </div>
        <span className="auth-brand-foot">BRING YOUR OWN KEY · V0.2</span>
      </div>
      <section className="login-panel" aria-labelledby={labelledBy}>
        {children}
      </section>
    </main>
  );
}
