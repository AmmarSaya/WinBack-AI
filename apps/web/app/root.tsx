import { type LinksFunction, type LoaderFunctionArgs, json } from '@remix-run/node';
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from '@remix-run/react';
import { AppProvider } from '@shopify/polaris';
import polarisTranslations from '@shopify/polaris/locales/en.json';
import polarisStyles from '@shopify/polaris/build/esm/styles.css?url';
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
        <AppProvider i18n={polarisTranslations}>
          <Outlet />
        </AppProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
