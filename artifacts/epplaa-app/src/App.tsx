import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { ThemeProvider } from "@/lib/theme-context";
import { CountryProvider } from "@/lib/country-context";
import { Layout } from "@/components/layout";

import Discovery from "@/pages/discovery";
import LiveShopping from "@/pages/live-shopping";
import ProductDetail from "@/pages/product-detail";
import Inbox from "@/pages/inbox";
import Profile from "@/pages/profile";
import PaymentMethods from "@/pages/account/payment-methods";
import Addresses from "@/pages/account/addresses";
import Settings from "@/pages/account/settings";
import { ThemeToggle } from "@/components/theme-toggle";

const queryClient = new QueryClient();

// Go live stub
function GoLive() {
  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center justify-between pt-12 pb-4 px-4">
        <h1 className="text-2xl font-bold">Go Live</h1>
        <ThemeToggle />
      </div>
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <p className="opacity-70 mb-8">Seller broadcasting tools are coming soon to Epplaa v2.</p>
        <button onClick={() => window.history.back()} className="px-6 py-2 bg-[#00ffff] text-black font-bold rounded-full">
          Go Back
        </button>
      </div>
    </div>
  );
}

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
        <Route path="/go-live" component={GoLive} />
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
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <Router />
            </WouterRouter>
            <Toaster />
          </TooltipProvider>
        </CountryProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
