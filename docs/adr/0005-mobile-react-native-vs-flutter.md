# ADR-0005: Mobile framework — React Native + Expo (supersedes spec ADR-007)

- **Status**: Accepted (supersedes spec ADR-007 *Flutter for mobile*)
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, Mobile Lead, CTO

## Context

The v4.1 spec ADR-007 selects Flutter (stable channel, Impeller, Dart,
Riverpod 2.x, go_router, dio, drift, flutter_webrtc, video_player +
chewie, FCM, Shorebird OTA) as the mobile framework. The rationale
is pixel-perfect rendering across mid-tier Nigerian Android devices
and pre-compiled-shader performance.

The current code base ships a React Native + Expo app at
`artifacts/epplaa-mobile`. The team's mobile expertise, the existing
auth scaffolding, the workspace's TypeScript-first stance, and the
ability to share `packages/api-client-react`, `packages/api-zod`, and
domain types between web and mobile all favour React Native.

Flutter's Impeller rendering advantage is real but has been
substantially closed by React Native's New Architecture (Fabric +
TurboModules + Hermes precompiled bytecode) on supported devices.
The Nigerian mid-tier device class (Android 10+, 3 GB RAM) renders
RN New Architecture apps acceptably for our UX targets (live video
viewer, product browse, checkout) — this has been validated against
the existing Expo build on physical devices.

## Decision

**React Native + Expo is the mobile framework of record.** Spec
ADR-007 is hereby superseded by this ADR.

Package mapping from the spec to the chosen stack:

| Concern | Spec (Flutter) | Chosen (RN + Expo) |
| :--- | :--- | :--- |
| State management | Riverpod 2.x | Zustand + TanStack Query |
| Routing | go_router | Expo Router |
| HTTP | dio | fetch + `packages/api-client-react` |
| Local DB | drift (sqlite) | Expo SQLite + Drizzle ORM (Expo driver) |
| Live host capture | flutter_webrtc | react-native-webrtc |
| HLS playback | video_player + chewie + ExoPlayer/AVPlayer bridges | expo-video |
| Push notifications | FCM (firebase_messaging) | Expo Notifications (FCM + APNs) |
| OTA updates | Shorebird | Expo EAS Update |
| Crash/error reporting | Sentry Flutter | Sentry React Native |
| Payments | Paystack Flutter SDK + Flutterwave Flutter SDK | Paystack RN SDK + Flutterwave RN SDK |

Performance and quality budgets from spec §5.5 are retained verbatim
(cold start, frame budget, install size on Android, memory ceiling).
The Phase 7 buildout (v4.2 amendment) is responsible for hitting them.

## Consequences

**Easier**
- One language (TypeScript) across web, mobile, and backend.
- `packages/api-client-react`, Zod schemas, and shared domain types
  are reused on mobile without code generation.
- The team's React Native fluency is leveraged; no Dart hiring or
  upskilling.
- Expo's managed workflow accelerates over-the-air updates and
  build/release.

**Harder**
- We accept slightly higher worst-case frame-time variance on the
  bottom-end of the mid-tier Android class compared to Impeller.
  Mitigated by performance budgets in CI (Phase 9 quality engineering)
  and by pre-launch device-lab testing.
- Two native runtimes to maintain (iOS, Android) but this is shared
  with Flutter — both frameworks have native escape hatches.

## Alternatives considered

- **Flutter as per spec ADR-007** — rejected because it would discard
  the existing RN/Expo investment, force Dart upskilling on a
  TypeScript-first team, and break the cross-stack package sharing
  that makes our monorepo valuable.
- **Native iOS (Swift) + native Android (Kotlin)** — rejected: 2×
  engineering cost for a launch-stage company.
- **Capacitor / Ionic** — rejected: WebView-based stacks fail the
  live-streaming host-side WebRTC capture path.
- **KMP (Kotlin Multiplatform) + Compose Multiplatform** — rejected:
  too early; Compose for iOS is alpha and the talent pool in Nigeria
  is shallow.

## Re-evaluation triggers

- React Native New Architecture is rolled back or materially regresses
  on the Nigerian mid-tier device class.
- A specific feature (e.g., custom video pipeline) demands per-frame
  GPU control that RN cannot expose without writing equivalent native
  modules to a Flutter port.
- The team composition shifts decisively to Flutter expertise via
  acquisition or hiring.
