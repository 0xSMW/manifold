// Prefixed ids (SPEC §6.1). Reuses @manifold/config's generator so control-plane and config
// package emit the same id shape (`<prefix>_<base36-time><hex-random>`).
import { genId } from "@manifold/config";

export { genId };
