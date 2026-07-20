import { useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

type Identity = 'Alice' | 'Bob';

interface RelayMessage {
  id: number;
  from: Identity;
  body: string;
}

// The public end-to-end relay runs on the simulator host. This deliberately
// contains no application-specific endpoint or credentials.
const relayUrl = 'http://127.0.0.1:4100';

function App() {
  const [message, setMessage] = useState('');
  const [didSend, setDidSend] = useState(false);
  const [identity, setIdentity] = useState<Identity>();
  const [receivedMessages, setReceivedMessages] = useState<RelayMessage[]>([]);
  const [latestMessageId, setLatestMessageId] = useState(0);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showExercises, setShowExercises] = useState(false);
  const [alertChoice, setAlertChoice] = useState('none');
  const canSend = identity !== undefined && message.trim().length > 0;

  useEffect(() => {
    if (!identity) {
      return undefined;
    }

    let cancelled = false;
    const receiveMessages = async () => {
      try {
        const response = await fetch(
          `${relayUrl}/messages?recipient=${encodeURIComponent(identity)}&after=${latestMessageId}`,
        );
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as {messages: RelayMessage[]};
        if (cancelled || payload.messages.length === 0) {
          return;
        }

        setReceivedMessages(current => [...current, ...payload.messages]);
        setLatestMessageId(
          current => Math.max(current, ...payload.messages.map(item => item.id)),
        );
      } catch {
        // The relay is intentionally optional outside the multi-device suite.
      }
    };

    void receiveMessages();
    const timer = setInterval(() => void receiveMessages(), 250);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [identity, latestMessageId]);

  const chooseIdentity = (nextIdentity: Identity) => {
    setIdentity(nextIdentity);
    setReceivedMessages([]);
    setLatestMessageId(0);
    setDidSend(false);
  };

  const sendMessage = async () => {
    if (!identity || !canSend) {
      return;
    }

    try {
      const response = await fetch(`${relayUrl}/messages`, {
        body: JSON.stringify({body: message, from: identity}),
        headers: {'Content-Type': 'application/json'},
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error('Relay rejected the message.');
      }
      setDidSend(true);
    } catch {
      setDidSend(false);
    }
  };

  if (showExercises) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.container} testID="exercises-screen">
          <Text style={styles.title}>Exercises</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              Alert.alert('Proceed?', 'This exercises native alert buttons.', [
                {
                  text: 'Cancel',
                  style: 'cancel',
                  onPress: () => setAlertChoice('cancelled'),
                },
                { text: 'Confirm', onPress: () => setAlertChoice('confirmed') },
              ])
            }
            style={styles.button}
            testID="rn-show-alert">
            <Text style={styles.buttonText}>Show Alert</Text>
          </Pressable>
          <Text accessibilityLabel={`Alert choice: ${alertChoice}`}>
            {`Alert choice: ${alertChoice}`}
          </Text>
          <ScrollView style={styles.exerciseList} testID="rn-exercise-list">
            {Array.from({ length: 30 }, (_, index) => (
              <Text
                key={index}
                style={styles.exerciseRow}
                testID={`rn-row-${index + 1}`}>
                {`Row ${index + 1}`}
              </Text>
            ))}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowExercises(false)}
            style={styles.button}
            testID="exercises-back">
            <Text style={styles.buttonText}>Back</Text>
          </Pressable>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

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

        <Pressable
          accessibilityRole="button"
          onPress={() => setShowExercises(true)}
          style={styles.secondaryButton}
          testID="exercises-link">
          <Text style={styles.secondaryButtonText}>Exercises</Text>
        </Pressable>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Peer identity</Text>
          <Text accessibilityLabel={identity ? `Identity: ${identity}` : 'Identity: not selected'}>
            {identity ? `Signed in as ${identity}` : 'Choose a peer identity'}
          </Text>
          <View style={styles.identityRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => chooseIdentity('Alice')}
              style={styles.secondaryButton}
              testID="identity-alice">
              <Text style={styles.secondaryButtonText}>Use Alice</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => chooseIdentity('Bob')}
              style={styles.secondaryButton}
              testID="identity-bob">
              <Text style={styles.secondaryButtonText}>Use Bob</Text>
            </Pressable>
          </View>
        </View>

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
            onPress={() => void sendMessage()}
            style={[styles.button, !canSend && styles.buttonDisabled]}
            testID="send">
            <Text style={styles.buttonText}>Send</Text>
          </Pressable>
          {didSend && (
            <Text
              accessibilityLabel="Delivery status: Delivered"
              style={styles.status}
              testID="delivery-status">
              Delivered
            </Text>
          )}
        </View>

        {receivedMessages.map(incoming => (
          <Text
            accessibilityLabel={`Incoming message from ${incoming.from}: ${incoming.body}`}
            key={incoming.id}
            style={styles.status}>
            {incoming.from}: {incoming.body}
          </Text>
        ))}

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
  exerciseList: {
    flexGrow: 0,
    height: 320,
    marginVertical: 12,
  },
  exerciseRow: {
    fontSize: 18,
    paddingVertical: 14,
  },
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
  identityRow: {
    flexDirection: 'row',
    gap: 12,
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
  secondaryButton: {
    alignItems: 'center',
    borderColor: '#2563eb',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    padding: 12,
  },
  secondaryButtonText: {
    color: '#1d4ed8',
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
