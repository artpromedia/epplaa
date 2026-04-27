import { Switch, Route, Router as WouterRouter } from "wouter";
import { ReactNode } from "react";
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
import { ReviewsProvider } from "@/lib/reviews-context";
import { FollowsProvider } from "@/lib/follows-context";
import { WishlistProvider } from "@/lib/wishlist-context";
import { WalletProvider, useWallet } from "@/lib/wallet-context";
import { ReturnsProvider } from "@/lib/returns-context";
import { SafetyProvider } from "@/lib/safety-context";
import { OnboardingProvider, useOnboarding } from "@/lib/onboarding-context";
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
import SellerEarnings from "@/pages/seller/earnings";
import SellerOrders from "@/pages/seller/orders";
import SellerStreamsPage from "@/pages/seller/streams";

import Cart from "@/pages/cart";
import CheckoutMethod from "@/pages/checkout/method";
import CheckoutLocation from "@/pages/checkout/location";
import CheckoutAddress from "@/pages/checkout/address";
import CheckoutPayment from "@/pages/checkout/payment";
import CheckoutReview from "@/pages/checkout/review";
import CheckoutSuccess from "@/pages/checkout/success";
import Orders from "@/pages/orders";
import OrderDetail from "@/pages/order-detail";
import Search from "@/pages/search";
import Wishlist from "@/pages/wishlist";
import RateOrder from "@/pages/reviews/rate-order";
import Replays from "@/pages/replays";
import ReplayDetail from "@/pages/replay-detail";
import ReturnsList from "@/pages/returns";
import RequestReturn from "@/pages/returns/request";
import ReturnDetail from "@/pages/returns/detail";
import WalletPage from "@/pages/wallet";
import SafetyHub from "@/pages/safety";
import ReportPage from "@/pages/safety/report";
import OnboardingWelcome from "@/pages/onboarding/welcome";
import ReferralsHub from "@/pages/referrals";

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
        <Route path="/orders/:orderId/rate" component={RateOrder} />
        <Route path="/returns" component={ReturnsList} />
        <Route path="/returns/new/:orderId" component={RequestReturn} />
        <Route path="/returns/:returnId" component={ReturnDetail} />
        <Route path="/wallet" component={WalletPage} />
        <Route path="/safety" component={SafetyHub} />
        <Route path="/safety/report" component={ReportPage} />
        <Route path="/referrals" component={ReferralsHub} />
        <Route path="/replays" component={Replays} />
        <Route path="/replay/:replayId" component={ReplayDetail} />
        <Route path="/inbox" component={Inbox} />
        <Route path="/profile" component={Profile} />
        <Route path="/search" component={Search} />
        <Route path="/wishlist" component={Wishlist} />
        <Route path="/account/payment-methods" component={PaymentMethods} />
        <Route path="/account/addresses" component={Addresses} />
        <Route path="/account/settings" component={Settings} />
        <Route path="/seller/apply" component={SellerApply} />
        <Route path="/seller/tiers" component={SellerTiers} />
        <Route path="/seller/studio" component={SellerStudio} />
        <Route path="/seller/listings" component={SellerListings} />
        <Route path="/seller/orders" component={SellerOrders} />
        <Route path="/seller/streams" component={SellerStreamsPage} />
        <Route path="/seller/go-live" component={SellerGoLive} />
        <Route path="/seller/earnings" component={SellerEarnings} />
        <Route path="/go-live" component={SellerGoLive} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

// Bridges wallet refunds into the returns context so a refunded return auto
// credits the wallet exactly once (using the return id as refId so the wallet
// can dedupe).
function ReturnsBridge({ children }: { children: ReactNode }) {
  const { refundFromReturn } = useWallet();
  return (
    <ReturnsProvider
      onRefund={(rec) =>
        refundFromReturn(rec.id, rec.refundAmountMinor, `Refund ${rec.id}`)
      }
    >
      {children}
    </ReturnsProvider>
  );
}

// Gates the buyer experience behind the welcome flow until completion.
function OnboardingGate({ children }: { children: ReactNode }) {
  const { completed } = useOnboarding();
  if (!completed) return <OnboardingWelcome />;
  return <>{children}</>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="system" storageKey="epplaa-theme">
        <CountryProvider>
          <SellerProvider>
            <OrdersProvider>
              <ReviewsProvider>
                <FollowsProvider>
                  <WishlistProvider>
                    <CartProvider>
                      <CheckoutProvider>
                        <WalletProvider>
                          <ReturnsBridge>
                            <SafetyProvider>
                              <OnboardingProvider>
                                <TooltipProvider>
                                  <WouterRouter
                                    base={import.meta.env.BASE_URL.replace(
                                      /\/$/,
                                      "",
                                    )}
                                  >
                                    <OnboardingGate>
                                      <Router />
                                    </OnboardingGate>
                                  </WouterRouter>
                                  <Toaster />
                                </TooltipProvider>
                              </OnboardingProvider>
                            </SafetyProvider>
                          </ReturnsBridge>
                        </WalletProvider>
                      </CheckoutProvider>
                    </CartProvider>
                  </WishlistProvider>
                </FollowsProvider>
              </ReviewsProvider>
            </OrdersProvider>
          </SellerProvider>
        </CountryProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
