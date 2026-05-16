/**
 * Ambient JSX types for Shopify App Bridge custom elements.
 *
 * App Bridge ships several Web Components (e.g. `ui-nav-menu`, `ui-modal`,
 * `ui-save-bar`, `ui-title-bar`) loaded via the App Bridge CDN script in
 * `root.tsx`. They are HTML custom elements — fully native — but TypeScript
 * doesn't know about them unless we declare them here, so without these
 * declarations every usage produces "Property 'ui-nav-menu' does not exist
 * on type 'JSX.IntrinsicElements'".
 *
 * Add new entries here as we adopt more App Bridge components. Keep the
 * prop types permissive (DetailedHTMLProps on HTMLElement) — App Bridge
 * components vary their attribute surface and we don't gain real safety
 * from narrowing.
 */

import 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ui-nav-menu': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
    }
  }
}
