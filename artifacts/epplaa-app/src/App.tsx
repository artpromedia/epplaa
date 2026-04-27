import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { ThemeProvider } from "@/lib/theme-context";
import { CountryProvider } from "@/lib/country-context";
import { SellerProvider } from "@/lib/seller-context";
import { Layout } from "@/components/layout";

import Discovery from "@/pages/discovery";
import LiveShopping from "@/pages/live-shopping";
import ProductDetail from "@/pages/product-detail";
import Inbox from "@/pages/inbox";
import Profile from "@/pages/profile";
import PaymentMethods from "@/pages/account/payment-methods";
import Addresses from "@/pages/account/addresses";
import Settings from "@/pages/account/settings";
import SellerApply from "@/pages/seller/apply";
import SellerTiers from "@/pages/seller/tiers";
import SellerStudio from "@/pages/seller/studio";
import SellerListings from "@/pages/seller/listings";
import SellerGoLive from "@/pages/seller/go-live";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Discovery} />
        <Route path="/discover" component={Discovery} />
        <Route path="/live/:streamId" component={LiveShopping} />
        <Route path="/product/:productId" component={ProductDetail} />
        <Route path="/inbox" component={Inbox} />
        <Route path="/profile" component={Profile} />
        <Route path="/account/payment-methods" component={PaymentMethods} />
        <Route path="/account/addresses" component={Addresses} />
        <Route path="/account/settings" component={Settings} />
        <Route path="/seller/apply" component={SellerApply} />
        <Route path="/seller/tiers" component={SellerTiers} />
        <Route path="/seller/studio" component={SellerStudio} />
        <Route path="/seller/listings" component={SellerListings} />
        <Route path="/seller/go-live" component={SellerGoLive} />
        <Route path="/go-live" component={SellerGoLive} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="system" storageKey="epplaa-theme">
        <CountryProvider>
          <SellerProvider>
            <TooltipProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                <Router />
              </WouterRouter>
              <Toaster />
            </TooltipProvider>
          </SellerProvider>
        </CountryProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
