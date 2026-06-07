import { type LinksFunction, type LoaderFunctionArgs, json } from '@remix-run/node';
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from '@remix-run/react';
import { AppProvider, Frame } from '@shopify/polaris';
import polarisStyles from '@shopify/polaris/build/esm/styles.css?url';
import polarisTranslations from '@shopify/polaris/locales/en.json';
import { getShopifyConfig } from '@winback/shopify';

export const links: LinksFunction = () => [{ rel: 'stylesheet', href: polarisStyles }];

export function loader(_: LoaderFunctionArgs) {
  // Expose only the API key (a public identifier). The secret never leaves
  // the server. App Bridge requires the API key in a meta tag for the
  // embedded experience to bootstrap.
  return json({ apiKey: getShopifyConfig().SHOPIFY_API_KEY });
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {/* App Bridge reads this at boot to initialize the embedded session. */}
        <meta name="shopify-api-key" content={apiKey} />
        <Meta />
        <Links />
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
      </head>
      <body>
        {/*
          App Bridge nav menu — renders into Shopify admin's own left
          sidebar (where Products / Orders / Customers etc. live), NOT
          inside the app iframe. This is the deliberate pattern over
          Polaris <Navigation>: the app gets full iframe width for
          content and the merchant sees our routes integrated with the
          admin chrome they already know.

          `rel="home"` marks the canonical landing route; App Bridge
          highlights it when the merchant clicks the app's name in the
          admin sidebar.

          Routes here mirror design.md's navigation section. Add new
          routes BOTH here and at design.md, or the doc drifts.
        */}
        <ui-nav-menu>
          <a href="/" rel="home">Home</a>
          <a href="/customers">Customers</a>
          <a href="/campaigns">Campaigns</a>
          <a href="/settings">Settings</a>
        </ui-nav-menu>
        <AppProvider i18n={polarisTranslations}>
          {/*
            Polaris Frame provides slots for Toast, Modal, ContextualSaveBar
            etc. that downstream pages can plug into. Required even if we
            don't use them yet — Polaris components that depend on Frame
            context silently no-op when it's missing.
          */}
          <Frame>
            <Outlet />
          </Frame>
        </AppProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
