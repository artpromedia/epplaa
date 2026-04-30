import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useRef, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { AuthButton } from "@/components/AuthButton";
import { AuthField } from "@/components/AuthField";
import { AuthScaffold } from "@/components/AuthScaffold";
import { useColors } from "@/hooks/useColors";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignInScreen() {
  const colors = useColors();
  const router = useRouter();
  const passwordRef = useRef<TextInput>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [submitting, setSubmitting] = useState(false);

  function validate() {
    const next: typeof errors = {};
    if (!EMAIL_RE.test(email.trim())) next.email = "Enter a valid email address.";
    if (password.length < 6) next.password = "Password must be at least 6 characters.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit() {
    if (!validate()) return;
    setSubmitting(true);
    try {
      // TODO(auth): wire to Clerk's mobile SDK once the auth provider
      // is set up for the Expo app. For now this is a UI-only stub
      // so the screens can be reviewed end-to-end. Mirror the web
      // flow at artifacts/epplaa-app/src/pages/auth/sign-in.tsx.
      await new Promise((r) => setTimeout(r, 600));
      router.replace("/(tabs)");
    } catch (err) {
      Alert.alert("Sign in failed", (err as Error).message ?? "Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthScaffold
      title="Welcome back"
      subtitle="Sign in to keep watching live shows and tracking your orders."
      footer={
        <View style={styles.footerRow}>
          <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
            New to Epplaa?{" "}
          </Text>
          <Pressable
            onPress={() => router.replace("/(auth)/sign-up")}
            hitSlop={6}
            testID="sign-in-go-sign-up"
          >
            <Text style={[styles.footerLink, { color: colors.secondary }]}>
              Create an account
            </Text>
          </Pressable>
        </View>
      }
    >
      <AuthField
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        textContentType="emailAddress"
        placeholder="you@example.com"
        returnKeyType="next"
        error={errors.email}
        onSubmitEditing={() => passwordRef.current?.focus()}
        testID="sign-in-email"
      />

      <AuthField
        ref={passwordRef}
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry={!showPassword}
        autoCapitalize="none"
        autoComplete="password"
        textContentType="password"
        placeholder="At least 6 characters"
        returnKeyType="go"
        error={errors.password}
        onSubmitEditing={onSubmit}
        testID="sign-in-password"
        trailing={
          <Pressable
            onPress={() => setShowPassword((v) => !v)}
            hitSlop={6}
            testID="sign-in-toggle-password"
          >
            <Feather
              name={showPassword ? "eye-off" : "eye"}
              size={18}
              color={colors.mutedForeground}
            />
          </Pressable>
        }
      />

      <Pressable
        onPress={() => Alert.alert("Reset password", "We'll send a reset link via email.")}
        style={styles.forgotRow}
        testID="sign-in-forgot"
      >
        <Text style={[styles.forgotText, { color: colors.secondary }]}>
          Forgot password?
        </Text>
      </Pressable>

      <AuthButton
        label="Sign in"
        onPress={onSubmit}
        loading={submitting}
        testID="sign-in-submit"
      />

      <View style={styles.dividerRow}>
        <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
        <Text style={[styles.dividerText, { color: colors.mutedForeground }]}>or</Text>
        <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
      </View>

      <AuthButton
        label="Continue with phone"
        variant="outline"
        onPress={() => router.push("/(auth)/phone")}
        testID="sign-in-phone"
      />
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  forgotRow: {
    alignSelf: "flex-end",
    paddingVertical: 4,
    marginTop: -4,
    marginBottom: 4,
  },
  forgotText: {
    fontFamily: "Inter_600SemiBold",
    fontWeight: "600",
    fontSize: 13,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 16,
    gap: 8,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1,
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
