import { withWorkflow } from "workflow/next";

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone"
};

export default withWorkflow(nextConfig);
