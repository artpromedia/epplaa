import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { AuthButton } from "@/components/AuthButton";
import { AuthField } from "@/components/AuthField";
import { AuthScaffold } from "@/components/AuthScaffold";
import { useColors } from "@/hooks/useColors";

type Channel = "whatsapp" | "sms";

interface DialCode {
  code: string;
  flag: string;
  name: string;
  dial: string;
}

const COUNTRIES: DialCode[] = [
  { code: "NG", flag: "🇳🇬", name: "Nigeria", dial: "+234" },
  { code: "GH", flag: "🇬🇭", name: "Ghana", dial: "+233" },
  { code: "KE", flag: "🇰🇪", name: "Kenya", dial: "+254" },
  { code: "ZA", flag: "🇿🇦", name: "South Africa", dial: "+27" },
];

export default function PhoneScreen() {
  const colors = useColors();
  const router = useRouter();

  const [country, setCountry] = useState<DialCode>(COUNTRIES[0]!);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState<Channel>("whatsapp");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onContinue() {
    const digits = phone.replace(/\D+/g, "");
    if (digits.length < 7) {
      setError("Enter a valid phone number.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // TODO(auth): call startOtp({ phone, channel }) from
      // @workspace/api-client-react and forward the dev code if the
      // backend returns one. UI-only stub today; see the web flow at
      // artifacts/epplaa-app/src/pages/auth/phone-sign-in.tsx.
      await new Promise((r) => setTimeout(r, 600));
      router.push({
        pathname: "/(auth)/verify",
        params: { phone: `${country.dial}${digits}`, channel },
      });
    } catch (err) {
      Alert.alert("Couldn't send code", (err as Error).message ?? "Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthScaffold
      title="Continue with phone"
      subtitle="We'll text you a 6-digit code to confirm it's really you."
      footer={
        <View style={styles.footerRow}>
          <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
            Prefer email?{" "}
          </Text>
          <Pressable
            onPress={() => router.replace("/(auth)/sign-in")}
            hitSlop={6}
            testID="phone-go-email"
          >
            <Text style={[styles.footerLink, { color: colors.secondary }]}>
              Sign in with email
            </Text>
          </Pressable>
        </View>
      }
    >
      <AuthField
        label="Phone number"
        value={phone}
        onChangeText={(t) => setPhone(t.replace(/[^\d\s-]/g, ""))}
        keyboardType="phone-pad"
        autoComplete="tel"
        textContentType="telephoneNumber"
        placeholder="801 234 5678"
        returnKeyType="go"
        error={error}
        onSubmitEditing={onContinue}
        testID="phone-input"
        leading={
          <Pressable
            onPress={() => setPickerOpen((v) => !v)}
            style={styles.dialBtn}
            testID="phone-country"
          >
            <Text style={styles.dialFlag}>{country.flag}</Text>
            <Text style={[styles.dialCode, { color: colors.foreground }]}>
              {country.dial}
            </Text>
          </Pressable>
        }
      />

      {pickerOpen ? (
        <View
          style={[
            styles.picker,
            {
              borderColor: colors.border,
              backgroundColor: colors.card,
              borderRadius: colors.radius,
            },
          ]}
        >
          {COUNTRIES.map((c) => {
            const selected = c.code === country.code;
            return (
              <Pressable
                key={c.code}
                onPress={() => {
                  setCountry(c);
                  setPickerOpen(false);
                }}
                style={[
                  styles.pickerRow,
                  {
                    backgroundColor: selected
                      ? colors.primary + "14"
                      : "transparent",
                  },
                ]}
                testID={`phone-country-${c.code}`}
              >
                <Text style={styles.dialFlag}>{c.flag}</Text>
                <Text
                  style={[styles.pickerName, { color: colors.foreground }]}
                >
                  {c.name}
                </Text>
                <Text
                  style={[styles.pickerDial, { color: colors.mutedForeground }]}
                >
                  {c.dial}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <Text style={[styles.channelLabel, { color: colors.foreground }]}>
        How should we send the code?
      </Text>
      <View style={styles.channelRow}>
        {(["whatsapp", "sms"] as Channel[]).map((c) => {
          const picked = channel === c;
          return (
            <Pressable
              key={c}
              onPress={() => setChannel(c)}
              style={[
                styles.channelPill,
                {
                  borderColor: picked ? colors.primary : colors.border,
                  backgroundColor: picked
                    ? colors.primary + "14"
                    : colors.card,
                  borderRadius: colors.radius,
                },
              ]}
              testID={`phone-channel-${c}`}
            >
              <Text
                style={[
                  styles.channelText,
                  { color: picked ? colors.primary : colors.mutedForeground },
                ]}
              >
                {c === "whatsapp" ? "WhatsApp" : "SMS"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <AuthButton
        label="Send code"
        onPress={onContinue}
        loading={submitting}
        testID="phone-submit"
      />
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  dialBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingRight: 10,
    paddingLeft: 0,
    gap: 6,
  },
  dialFlag: {
    fontSize: 18,
  },
  dialCode: {
    fontFamily: "Inter_600SemiBold",
    fontWeight: "600",
    fontSize: 15,
  },
  picker: {
    borderWidth: 1,
    overflow: "hidden",
  },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  pickerName: {
    flex: 1,
    fontFamily: "Inter_600SemiBold",
    fontWeight: "600",
    fontSize: 14,
  },
  pickerDial: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  channelLabel: {
    fontFamily: "Inter_600SemiBold",
    fontWeight: "600",
    fontSize: 13,
    marginTop: 8,
  },
  channelRow: {
    flexDirection: "row",
    gap: 10,
  },
  channelPill: {
    flex: 1,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  channelText: {
    fontFamily: "Inter_700Bold",
    fontWeight: "700",
    fontSize: 14,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
  },
  footerText: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
  footerLink: {
    fontFamily: "Inter_700Bold",
    fontWeight: "700",
    fontSize: 14,
  },
});
