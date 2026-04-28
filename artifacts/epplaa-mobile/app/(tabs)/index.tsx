import { Image, ScrollView, StyleSheet, Text, View } from "react-native";

export default function TabOneScreen() {
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.brandRow}>
        <Image
          source={require("@/assets/images/logo.png")}
          style={styles.logo}
          resizeMode="contain"
          accessibilityLabel="Epplaa"
        />
      </View>

      <Text style={styles.headline}>Live shopping. Fast delivery. Easy pickup.</Text>
      <Text style={styles.subhead}>
        Watch live drops from Lagos sellers, then collect at any Epplaa Box near you.
      </Text>

      <View style={styles.boxCard}>
        <Image
          source={require("@/assets/images/epplaa-box.png")}
          style={styles.boxImage}
          resizeMode="cover"
          accessibilityLabel="Epplaa Box pickup locker"
        />
        <View style={styles.boxOverlay}>
          <Text style={styles.boxKicker}>Epplaa Box</Text>
          <Text style={styles.boxTitle}>Pick up here. Anytime.</Text>
          <Text style={styles.boxSubtitle}>Victoria Island, Lagos · more locations soon</Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>What you can do today</Text>
      <View style={styles.featureCard}>
        <Text style={styles.featureTitle}>Browse live shopping</Text>
        <Text style={styles.featureText}>
          Tune in to Naija sellers showing off products in real time.
        </Text>
      </View>
      <View style={styles.featureCard}>
        <Text style={styles.featureTitle}>Order with one tap</Text>
        <Text style={styles.featureText}>
          Naira and dollar checkout via Paystack and Flutterwave.
        </Text>
      </View>
      <View style={styles.featureCard}>
        <Text style={styles.featureTitle}>Collect at an Epplaa Box</Text>
        <Text style={styles.featureText}>
          Free pickup at our locker network, with door delivery as a backup.
        </Text>
      </View>
    </ScrollView>
  );
}

const NAVY = "#0F1525";
const NAVY_SOFT = "#171C30";
const ACCENT = "#5BA3F5";
const TEXT = "#F2F4F8";
const MUTED = "rgba(242, 244, 248, 0.65)";

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: NAVY,
  },
  container: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 48,
    gap: 16,
  },
  brandRow: {
    alignItems: "flex-start",
    marginBottom: 4,
  },
  logo: {
    height: 40,
    width: 140,
  },
  headline: {
    fontSize: 24,
    fontWeight: "800",
    color: TEXT,
    lineHeight: 30,
  },
  subhead: {
    fontSize: 14,
    color: MUTED,
    lineHeight: 20,
  },
  boxCard: {
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: NAVY_SOFT,
    marginTop: 8,
  },
  boxImage: {
    width: "100%",
    height: 180,
  },
  boxOverlay: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 4,
  },
  boxKicker: {
    fontSize: 10,
    letterSpacing: 1.4,
    fontWeight: "800",
    color: ACCENT,
    textTransform: "uppercase",
  },
  boxTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: TEXT,
  },
  boxSubtitle: {
    fontSize: 12,
    color: MUTED,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: MUTED,
    textTransform: "uppercase",
    letterSpacing: 1.1,
    marginTop: 16,
  },
  featureCard: {
    backgroundColor: NAVY_SOFT,
    borderRadius: 16,
    padding: 16,
    gap: 6,
  },
  featureTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: TEXT,
  },
  featureText: {
    fontSize: 13,
    color: MUTED,
    lineHeight: 18,
  },
});
