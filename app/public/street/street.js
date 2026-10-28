// Main Street: window.LocalAIStreet. home.js loads street/*.js (its STREET_MODS) the first time Home shows the street.
// Each building file registers one def: {id, width, state(world), stillKey?(state), drawStill(ctx, state, env),
// drawLive(ctx, state, t, env), chip(state) -> {title, detail, tone}, open?(item)}. width is in scene units; the scene
// is 360 units tall with the ground line at y = 300, and a building draws in its own box x in [0, width]. env is
// {night, reduced, zoom, dpr}. Buildings stand left to right in ORDER; a key with no registered def is skipped.
// This is the skeleton (register, ORDER, defs); the engine (mount, setWorld, the loop) builds on it.
(function(root){'use strict';
const ORDER=Object.freeze(['chat','images','missions','garage','sheets','clock','foundry','workshop','kiosk','yard']);
const byId=new Map();
function register(def){if(!def||typeof def.id!=='string'||!def.id)throw new TypeError('a street def needs an id');byId.set(def.id,def);return def}
function defs(){return ORDER.filter(id=>byId.has(id)).map(id=>byId.get(id))}
const api=root.LocalAIStreet=Object.assign(root.LocalAIStreet||{},{register,ORDER,defs});
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
