import { createHash } from "node:crypto";
const stable = (value) => {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stable).join(",")}]`;
    return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
        .join(",")}}`;
};
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const contentHash = (value) => sha256(stable(value));
