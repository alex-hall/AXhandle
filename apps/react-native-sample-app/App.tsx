import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

function App() {
  const [message, setMessage] = useState('');
  const [didSend, setDidSend] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const canSend = message.trim().length > 0;

  if (showDetails) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.container} testID="details-screen">
          <Text style={styles.title}>Details screen</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowDetails(false)}
            style={styles.button}>
            <Text style={styles.buttonText}>Back</Text>
          </Pressable>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container} testID="sample-root">
        <Text style={styles.title}>AXe React Native Sample</Text>

        <View style={styles.card} testID="composer">
          <Text style={styles.sectionTitle} testID="composer-title">
            Message composer
          </Text>
          <TextInput
            accessibilityLabel="Message"
            onChangeText={value => {
              setMessage(value);
              setDidSend(false);
            }}
            placeholder="Message"
            style={styles.input}
            testID="message-input"
            value={message}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            onPress={() => setDidSend(true)}
            style={[styles.button, !canSend && styles.buttonDisabled]}
            testID="send">
            <Text style={styles.buttonText}>Send</Text>
          </Pressable>
          {didSend && (
            <Text style={styles.status} testID="delivery-status">
              Delivered
            </Text>
          )}
        </View>

        <View style={styles.card}>
          <View style={styles.switchRow}>
            <Text style={styles.sectionTitle}>Notifications</Text>
            <Switch
              accessibilityLabel="Notifications"
              onValueChange={setNotificationsEnabled}
              testID="notifications"
              value={notificationsEnabled}
            />
          </View>
          <Pressable
            accessibilityRole="link"
            onPress={() => setShowDetails(true)}
            style={styles.link}
            testID="details-link">
            <Text style={styles.linkText}>Details</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#ffffff',
    flex: 1,
    padding: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 24,
  },
  card: {
    borderColor: '#d4d4d8',
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
    marginBottom: 16,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  input: {
    borderColor: '#a1a1aa',
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 17,
    padding: 12,
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#2563eb',
    borderRadius: 8,
    padding: 12,
  },
  buttonDisabled: {
    backgroundColor: '#a1a1aa',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '600',
  },
  status: {
    color: '#15803d',
    fontSize: 17,
  },
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  link: {
    paddingVertical: 8,
  },
  linkText: {
    color: '#2563eb',
    fontSize: 17,
  },
});

export default App;
