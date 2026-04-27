import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { ThemeProvider } from "@/lib/theme-context";
import { CountryProvider } from "@/lib/country-context";
import { SellerProvider } from "@/lib/seller-context";
import { CartProvider } from "@/lib/cart-context";
import { OrdersProvider } from "@/lib/orders-context";
import { CheckoutProvider } from "@/lib/checkout-context";
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

import Cart from "@/pages/cart";
import CheckoutMethod from "@/pages/checkout/method";
import CheckoutLocation from "@/pages/checkout/location";
import CheckoutAddress from "@/pages/checkout/address";
import CheckoutPayment from "@/pages/checkout/payment";
import CheckoutReview from "@/pages/checkout/review";
import CheckoutSuccess from "@/pages/checkout/success";
import Orders from "@/pages/orders";
import OrderDetail from "@/pages/order-detail";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Discovery} />
        <Route path="/discover" component={Discovery} />
        <Route path="/live/:streamId" component={LiveShopping} />
        <Route path="/product/:productId" component={ProductDetail} />
        <Route path="/cart" component={Cart} />
        <Route path="/checkout" component={CheckoutMethod} />
        <Route path="/checkout/location" component={CheckoutLocation} />
        <Route path="/checkout/address" component={CheckoutAddress} />
        <Route path="/checkout/payment" component={CheckoutPayment} />
        <Route path="/checkout/review" component={CheckoutReview} />
        <Route path="/checkout/success/:orderId" component={CheckoutSuccess} />
        <Route path="/orders" component={Orders} />
        <Route path="/orders/:orderId" component={OrderDetail} />
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
            <OrdersProvider>
              <CartProvider>
                <CheckoutProvider>
                  <TooltipProvider>
                    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                      <Router />
                    </WouterRouter>
                    <Toaster />
                  </TooltipProvider>
                </CheckoutProvider>
              </CartProvider>
            </OrdersProvider>
          </SellerProvider>
        </CountryProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
