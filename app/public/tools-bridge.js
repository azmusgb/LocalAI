// The house's tool registry (appliance-ui's tools.json, synced into /ui/tools.js) for Local AI's classic scripts:
// window.ApplianceTools. A module runs before DOMContentLoaded, so ui.js's header and every later caller see it.
// Platform step 7, PR 7.7 (Decision 6): "← Home" and Pi Hub's links come from here, not from a copied address.
import { REAL, TOOLS, tool, toolUrl, toolsFor } from '/ui/tools.js';

window.ApplianceTools = Object.freeze({ REAL, TOOLS, tool, toolUrl, toolsFor });
