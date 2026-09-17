/**
 * The one React island in an otherwise vanilla page: the two beams that dress
 * the composer.
 *
 * - `border-beam` travels the brand palette around the composer's edge on the
 *   opening screen, and gets out of the way once you click in or start talking.
 * - `voice-glow` blooms along the bottom edge and answers the customer's voice
 *   while the microphone is open, and gathers into one travelling beam while
 *   the agent is thinking.
 *
 * Both ship as React components and this app has no React and no bundler.
 * Rather than convert the page, the island is kept to exactly what the two
 * libraries need: a root that renders them around an empty host div, into
 * which the existing composer <form> is physically moved. React never has
 * children of its own in that node, so it never diffs the form away, and every
 * listener app.js attached survives the move.
 *
 * `npm run build:web` bundles this to src/web/vendor/composer-beams.js, which
 * is what the page actually loads.
 */

import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { BorderBeam } from 'border-beam';
import { VoiceBeam } from 'voice-glow';

let root = null;
let child = null;
let radius = 24;

const props = { stream: null, processing: false, active: false, ring: false };

/* Module-level, so its identity never changes between renders and React has
 * no reason to detach the host node and hand it back. */
function attach(node) {
  if (node && child && child.parentNode !== node) node.appendChild(child);
}

function draw() {
  if (!root) return;
  root.render(
    h(
      BorderBeam,
      {
        active: props.ring,
        size: 'md',
        theme: 'light',
        // The pace and weight the hand-rolled conic gradient ran at, kept so
        // the opening screen reads the same.
        duration: 4,
        strength: 0.9,
        // Its first child is the voice wrapper, which has no corner of its
        // own, so the composer's is passed in rather than detected.
        borderRadius: radius,
        className: 'border-beam',
      },
      h(
        VoiceBeam,
        {
          // The mic stream drives the glow; `processing` gathers it into the
          // travelling beam while the agent is thinking.
          stream: props.stream,
          processing: props.processing,
          active: props.active,
          theme: 'light',
          className: 'voice-beam',
        },
        // The radius is read off this node by the library, so it carries the
        // composer's own corner from styles.css.
        h('div', { ref: attach, className: 'voice-beam-host' }),
      ),
    ),
  );
}

/** Wraps `form` in both beams, in place. */
export function mountComposerBeams(form) {
  if (root) return;
  child = form;
  radius = parseFloat(getComputedStyle(form).borderTopLeftRadius) || radius;
  const mount = document.createElement('div');
  mount.className = 'composer-beams';
  form.parentNode.insertBefore(mount, form);
  root = createRoot(mount);
  draw();
}

/** Partial update: `{ stream, processing, active, ring }`. */
export function setComposerBeams(next) {
  let changed = false;
  for (const [key, value] of Object.entries(next)) {
    if (props[key] !== value) {
      props[key] = value;
      changed = true;
    }
  }
  if (changed) draw();
}
