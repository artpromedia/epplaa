import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { AuthButton } from "@/components/AuthButton";
import { AuthScaffold } from "@/components/AuthScaffold";
import { useColors } from "@/hooks/useColors";

const CODE_LEN = 6;
const RESEND_AFTER = 30;

export default function VerifyScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ phone?: string; channel?: string }>();
  const phone = params.phone ?? "";
  const channel = params.channel === "sms" ? "SMS" : "WhatsApp";

  const inputs = useRef<Array<TextInput | null>>([]);
  const [digits, setDigits] = useState<string[]>(() => Array(CODE_LEN).fill(""));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(RESEND_AFTER);

  // Resend countdown — restarts whenever it hits zero only via "Resend".
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  function setDigit(idx: number, value: string) {
    const ch = value.replace(/\D+/g, "").slice(-1);
    setDigits((prev) => {
      const next = [...prev];
      next[idx] = ch;
      return next;
    });
    if (ch && idx < CODE_LEN - 1) inputs.current[idx + 1]?.focus();
  }

  function onKeyPress(idx: number, key: string) {
    if (key === "Backspace" && !digits[idx] && idx > 0) {
      inputs.current[idx - 1]?.focus();
    }
  }

  async function onVerify() {
    const code = digits.join("");
    if (code.length < CODE_LEN) {
      setError(`Enter all ${CODE_LEN} digits.`);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // TODO(auth): call verifyOtp({ phone, code }) and exchange the
      // returned ticket via Clerk's signIn.create({ strategy: "ticket" }).
      // Mirror the web flow at
      // artifacts/epplaa-app/src/pages/auth/phone-sign-in.tsx.
      await new Promise((r) => setTimeout(r, 700));
      router.replace("/(tabs)");
    } catch (err) {
      setError("Wrong or expired code. Request a new one.");
      Alert.alert("Verification failed", (err as Error).message ?? "Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function onResend() {
    if (secondsLeft > 0) return;
    setDigits(Array(CODE_LEN).fill(""));
    setSecondsLeft(RESEND_AFTER);
    inputs.current[0]?.focus();
    // TODO(auth): re-trigger startOtp here against the same phone/channel.
  }

  return (
    <AuthScaffold
      title="Enter the code"
      subtitle={`We sent a ${CODE_LEN}-digit code to ${phone || "your phone"} via ${channel}.`}
    >
      <View style={styles.codeRow}>
        {digits.map((d, i) => (
          <TextInput
            key={i}
            ref={(node) => {
              inputs.current[i] = node;
            }}
            value={d}
            onChangeText={(v) => setDigit(i, v)}
            onKeyPress={(e) => onKeyPress(i, e.nativeEvent.key)}
            keyboardType="number-pad"
            maxLength={1}
            textContentType="oneTimeCode"
            autoComplete="sms-otp"
            style={[
              styles.codeBox,
              {
                borderColor: error
                  ? colors.destructive
                  : d
                    ? colors.primary
                    : colors.border,
                backgroundColor: colors.card,
                color: colors.foreground,
                borderRadius: colors.radius,
              },
            ]}
            testID={`verify-digit-${i}`}
          />
        ))}
      </View>
      {error ? (
        <Text style={[styles.errorText, { color: colors.destructive }]}>
          {error}
        </Text>
      ) : null}

      <AuthButton
        label="Verify and continue"
        onPress={onVerify}
        loading={submitting}
        testID="verify-submit"
      />

      <View style={styles.resendRow}>
        <Text style={[styles.resendCopy, { color: colors.mutedForeground }]}>
          Didn't get it?{" "}
        </Text>
        <Pressable
          onPress={onResend}
          disabled={secondsLeft > 0}
          testID="verify-resend"
        >
          <Text
            style={[
              styles.resendAction,
              {
                color: secondsLeft > 0 ? colors.mutedForeground : colors.secondary,
              },
            ]}
          >
            {secondsLeft > 0 ? `Resend in ${secondsLeft}s` : "Resend code"}
          </Text>
        </Pressable>
      </View>

      <Pressable
        onPress={() => router.back()}
        style={styles.changeRow}
        testID="verify-change-number"
      >
        <Text style={[styles.changeText, { color: colors.foreground }]}>
          Use a different number
        </Text>
      </Pressable>
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  codeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
    marginVertical: 8,
  },
  codeBox: {
    flex: 1,
    minWidth: 0,
    width: 0,
    height: 56,
    borderWidth: 1,
    textAlign: "center",
    fontFamily: "Inter_700Bold",
    fontWeight: "700",
    fontSize: 22,
  },
  errorText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    marginTop: -2,
  },
  resendRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 16,
  },
  resendCopy: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  resendAction: {
    fontFamily: "Inter_700Bold",
    fontWeight: "700",
    fontSize: 13,
  },
  changeRow: {
    alignItems: "center",
    paddingVertical: 12,
    marginTop: 4,
  },
  changeText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    textDecorationLine: "underline",
  },
});
