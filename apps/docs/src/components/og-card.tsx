const INK = "#11100f";
const PAPER = "#f5f2eb";
const PURPLE = "#7657ff";
const PURPLE_BRIGHT = "#8b72ff";
const PAPER_MUTED = "rgba(245, 242, 235, 0.58)";
const PAPER_LINE = "rgba(245, 242, 235, 0.16)";

export const OG_IMAGE_SIZE = { width: 1200, height: 630 };

type OgCardProps = {
  readonly title: string;
  readonly description?: string;
  readonly section?: string;
  readonly brandMark?: string;
};

/**
 * Sizes the headline so long titles stay on two lines at 1200x630.
 *
 * Satori resolves `letterSpacing` in pixels, so the tracking is scaled here
 * instead of being expressed in `em`.
 */
function headline(title: string): { fontSize: number; letterSpacing: number } {
  const fontSize = title.length > 44 ? 62 : title.length > 26 ? 72 : 84;
  return { fontSize, letterSpacing: -(fontSize * 0.045) };
}

function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function OgCard({ title, description, section, brandMark }: OgCardProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        padding: "76px 80px 92px",
        backgroundColor: INK,
        color: PAPER
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          {brandMark ? (
            <img alt="" src={brandMark} width={58} height={58} style={{ marginRight: 22 }} />
          ) : null}
          <div style={{ display: "flex", fontSize: 34, letterSpacing: -0.7 }}>RouteKit</div>
          <div
            style={{
              display: "flex",
              width: 1,
              height: 32,
              margin: "0 20px",
              backgroundColor: "rgba(245, 242, 235, 0.28)"
            }}
          />
          <div style={{ display: "flex", fontSize: 19, letterSpacing: 4.6, color: PAPER_MUTED }}>
            DOCS
          </div>
        </div>
        {section ? (
          <div style={{ display: "flex", fontSize: 19, letterSpacing: 4.6, color: PURPLE_BRIGHT }}>
            {section}
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", flexGrow: 1 }} />

      <div style={{ display: "flex", width: "100%", height: 1, backgroundColor: PAPER_LINE }} />

      <div
        style={{
          display: "flex",
          marginTop: 44,
          lineHeight: 1.05,
          ...headline(title)
        }}
      >
        {clamp(title, 78)}
      </div>

      {description ? (
        <div
          style={{
            display: "flex",
            maxWidth: 940,
            marginTop: 26,
            fontSize: 29,
            lineHeight: 1.4,
            color: PAPER_MUTED
          }}
        >
          {clamp(description, 128)}
        </div>
      ) : null}

      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          width: OG_IMAGE_SIZE.width,
          height: 10,
          backgroundColor: PURPLE
        }}
      />
    </div>
  );
}
