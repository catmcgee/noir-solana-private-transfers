import { useState, useCallback, ReactNode, Component, ErrorInfo } from 'react'
import { createClient, autoDiscover } from '@solana/client'
import { SolanaProvider, useWalletConnection } from '@solana/react-hooks'
import { WalletButton, BalanceDisplay, DepositSection, WithdrawSection } from './components'
import { getWalletAddress } from './utils'
import { DEVNET_ENDPOINT } from './constants'
import type { DepositNote } from './types'

export type { DepositNote, WithdrawalProof } from './types'

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0e1116] flex items-center justify-center">
          <div className="bg-[#1a1f2e] p-8 rounded-lg max-w-md border border-[#2d3748]">
            <h2 className="text-xl font-bold text-red-400 mb-4">Something went wrong</h2>
            <p className="text-gray-400 mb-4">
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 btn-primary text-white rounded"
            >
              Reload Page
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

const client = createClient({
  endpoint: DEVNET_ENDPOINT,
  walletConnectors: autoDiscover(),
})

function AppProviders({ children }: { children: ReactNode }) {
  return (
    <SolanaProvider client={client}>
      {children}
    </SolanaProvider>
  )
}

function MainApp() {
  const { wallet } = useWalletConnection()
  const [depositNote, setDepositNote] = useState<DepositNote | null>(null)

  const walletAddress = getWalletAddress(wallet)

  const handleDepositComplete = useCallback((note: DepositNote) => {
    setDepositNote(note)
  }, [])

  return (
    <div className="min-h-screen bg-[#0e1116]">
      <header className="border-b border-[#2d3748]">
        <div className="max-w-5xl mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold gradient-text">Private Transfers</h1>
          <WalletButton />
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        <div className="bg-[#1a1f2e] border border-[#2d3748] rounded-lg p-5 mb-8">
          <h2 className="font-semibold text-[#14F195] mb-2">How it works</h2>
          <p className="text-gray-400 text-sm">
            Private transfers use zero-knowledge proofs to break the link between depositor and
            withdrawer. Your deposit creates a commitment that can be withdrawn by proving knowledge
            of a secret - without revealing which deposit you're claiming.
          </p>
          <div className="mt-4 text-gray-400 text-sm">
            <p className="text-gray-300 font-medium mb-2">Flow:</p>
            <ol className="list-decimal ml-5 space-y-1">
              <li>Enter an amount and click Deposit</li>
              <li>Sign the transaction to deposit SOL</li>
              <li>Enter a recipient address and click Withdraw</li>
              <li>Sign the withdrawal transaction to receive funds</li>
            </ol>
          </div>
        </div>

        {!walletAddress ? (
          <div className="text-center py-16 bg-[#1a1f2e] rounded-lg border border-[#2d3748]">
            <p className="text-gray-400 mb-6">Connect your wallet to use private transfers</p>
            <WalletButton />
          </div>
        ) : (
          <>
            <BalanceDisplay />
            <div className="grid md:grid-cols-2 gap-6">
              <DepositSection onDepositComplete={handleDepositComplete} />
              <WithdrawSection depositNote={depositNote} />
            </div>
          </>
        )}
      </main>

      <footer className="border-t border-[#2d3748] mt-16">
        <div className="max-w-5xl mx-auto px-4 py-4 text-center text-gray-500 text-sm">
          Demo project - Devnet only
        </div>
      </footer>
    </div>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <AppProviders>
        <MainApp />
      </AppProviders>
    </ErrorBoundary>
  )
}

export default App
