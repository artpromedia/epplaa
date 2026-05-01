import { useSignUp } from "@clerk/clerk-expo";
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

export default function SignUpScreen() {
  const colors = useColors();
  const router = useRouter();
  const { signUp, setActive, isLoaded } = useSignUp();
  const lastNameRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [errors, setErrors] = useState<{
    firstName?: string;
    lastName?: string;
    email?: string;
    password?: string;
    agreed?: string;
  }>({});
  const [submitting, setSubmitting] = useState(false);

  function validate() {
    const next: typeof errors = {};
    if (firstName.trim().length < 2) next.firstName = "Enter your first name.";
    if (lastName.trim().length < 2) next.lastName = "Enter your last name.";
    if (!EMAIL_RE.test(email.trim())) next.email = "Enter a valid email address.";
    if (password.length < 8)
      next.password = "Use at least 8 characters for a stronger password.";
    if (!agreed) next.agreed = "Please accept the terms to continue.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit() {
    if (!validate()) return;
    if (!isLoaded || !signUp) {
      Alert.alert("Auth not ready", "Try again in a moment.");
      return;
    }
    setSubmitting(true);
    try {
      const attempt = await signUp.create({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        emailAddress: email.trim(),
        password,
      });

      // If Clerk requires email verification (the default), kick off the
      // email-code strategy and redirect to a verification screen. The
      // verify screen itself is shared with the phone flow — it accepts
      // either an OTP+phone or a Clerk emailAddressId+code.
      if (attempt.status === "missing_requirements") {
        await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
        router.push({
          pathname: "/(auth)/verify",
          params: { mode: "email", email: email.trim() },
        });
        return;
      }

      if (attempt.status === "complete") {
        await setActive({ session: attempt.createdSessionId });
        router.replace("/(tabs)");
        return;
      }

      Alert.alert(
        "Additional step required",
        `Sign-up needs further verification (status: ${attempt.status}).`,
      );
    } catch (err) {
      Alert.alert("Sign up failed", (err as Error).message ?? "Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthScaffold
      title="Create your account"
      subtitle="Join Epplaa to follow your favorite live sellers and shop in your local currency."
      footer={
        <View style={styles.footerRow}>
          <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
            Already have an account?{" "}
          </Text>
          <Pressable
            onPress={() => router.replace("/(auth)/sign-in")}
            hitSlop={6}
            testID="sign-up-go-sign-in"
          >
            <Text style={[styles.footerLink, { color: colors.secondary }]}>
              Sign in
            </Text>
          </Pressable>
        </View>
      }
    >
      <View style={styles.row}>
        <View style={styles.rowItem}>
          <AuthField
            label="First name"
            value={firstName}
            onChangeText={setFirstName}
            autoCapitalize="words"
            autoComplete="given-name"
            textContentType="givenName"
            placeholder="Ada"
            returnKeyType="next"
            error={errors.firstName}
            onSubmitEditing={() => lastNameRef.current?.focus()}
            testID="sign-up-first-name"
          />
        </View>
        <View style={styles.rowItem}>
          <AuthField
            ref={lastNameRef}
            label="Last name"
            value={lastName}
            onChangeText={setLastName}
            autoCapitalize="words"
            autoComplete="family-name"
            textContentType="familyName"
            placeholder="Eze"
            returnKeyType="next"
            error={errors.lastName}
            onSubmitEditing={() => emailRef.current?.focus()}
            testID="sign-up-last-name"
          />
        </View>
      </View>

      <AuthField
        ref={emailRef}
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
        testID="sign-up-email"
      />

      <AuthField
        ref={passwordRef}
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry={!showPassword}
        autoCapitalize="none"
        autoComplete="password-new"
        textContentType="newPassword"
        placeholder="At least 8 characters"
        returnKeyType="go"
        error={errors.password}
        helperText={
          errors.password ? null : "Mix letters, numbers, and a symbol for extra safety."
        }
        onSubmitEditing={onSubmit}
        testID="sign-up-password"
        trailing={
          <Pressable
            onPress={() => setShowPassword((v) => !v)}
            hitSlop={6}
            testID="sign-up-toggle-password"
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
        onPress={() => setAgreed((v) => !v)}
        style={styles.agreeRow}
        testID="sign-up-terms"
      >
        <View
          style={[
            styles.checkbox,
            {
              borderColor: errors.agreed ? colors.destructive : colors.border,
              backgroundColor: agreed ? colors.primary : "transparent",
              borderRadius: 6,
            },
          ]}
        >
          {agreed ? (
            <Feather name="check" size={14} color={colors.primaryForeground} />
          ) : null}
        </View>
        <Text style={[styles.agreeText, { color: colors.foreground }]}>
          I agree to the{" "}
          <Text style={{ color: colors.secondary }}>Terms of Service</Text>
          {" "}and{" "}
          <Text style={{ color: colors.secondary }}>Privacy Policy</Text>.
        </Text>
      </Pressable>
      {errors.agreed ? (
        <Text style={[styles.errorText, { color: colors.destructive }]}>
          {errors.agreed}
        </Text>
      ) : null}

      <AuthButton
        label="Create account"
        onPress={onSubmit}
        loading={submitting}
        testID="sign-up-submit"
      />

      <View style={styles.dividerRow}>
        <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
        <Text style={[styles.dividerText, { color: colors.mutedForeground }]}>or</Text>
        <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
      </View>

      <AuthButton
        label="Sign up with phone"
        variant="outline"
        onPress={() => router.push("/(auth)/phone")}
        testID="sign-up-phone"
      />
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 12,
  },
  rowItem: {
    flex: 1,
  },
  agreeRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginTop: 4,
    paddingVertical: 4,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  agreeText: {
    flex: 1,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    lineHeight: 18,
  },
  errorText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    marginTop: -4,
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
