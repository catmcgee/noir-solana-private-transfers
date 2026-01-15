import { useState } from 'react'
import { useWalletConnection, useSendTransaction } from '@solana/react-hooks'
import { getProgramDerivedAddress, getBytesEncoder, getAddressEncoder } from '@solana/kit'
import { getDepositInstructionDataEncoder, PRIVATE_TRANSFERS_PROGRAM_ADDRESS } from '../generated'
import { getWalletAddress } from '../utils'
import { API_URL, LAMPORTS_PER_SOL, SEEDS, SYSTEM_PROGRAM_ID, DEFAULT_DEPOSIT_AMOUNT } from '../constants'
import type { DepositNote, DepositApiResponse } from '../types'

interface DepositSectionProps {
  onDepositComplete: (note: DepositNote) => void
}

export function DepositSection({ onDepositComplete }: DepositSectionProps) {
  const { wallet } = useWalletConnection()
  const { send: sendTransaction, isSending } = useSendTransaction()
  const [amount, setAmount] = useState(DEFAULT_DEPOSIT_AMOUNT)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)

  const walletAddress = getWalletAddress(wallet)

  const handleDeposit = async () => {
    if (!walletAddress || !wallet) return

    setLoading(true)
    setStatus('Generating deposit note...')

    try {
      const amountLamports = Math.floor(parseFloat(amount) * Number(LAMPORTS_PER_SOL))

      const response = await fetch(`${API_URL}/api/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: amountLamports,
          depositor: walletAddress
        })
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to generate deposit')
      }

      const { depositNote, onChainData }: DepositApiResponse = await response.json()

      console.log('[Deposit] Generated note:', depositNote.commitment.slice(0, 20) + '...')

      setStatus('Submitting deposit to blockchain...')

      const programAddress = PRIVATE_TRANSFERS_PROGRAM_ADDRESS

      const [poolPda] = await getProgramDerivedAddress({
        programAddress,
        seeds: [getBytesEncoder().encode(SEEDS.POOL)],
      })

      const [poolVaultPda] = await getProgramDerivedAddress({
        programAddress,
        seeds: [
          getBytesEncoder().encode(SEEDS.VAULT),
          getAddressEncoder().encode(poolPda),
        ],
      })

      const dataEncoder = getDepositInstructionDataEncoder()
      const instructionData = dataEncoder.encode({
        commitment: new Uint8Array(onChainData.commitment),
        newRoot: new Uint8Array(onChainData.newRoot),
        amount: BigInt(onChainData.amount),
      })

      const depositInstruction = {
        programAddress,
        accounts: [
          { address: poolPda, role: 1 },
          { address: poolVaultPda, role: 1 },
          { address: walletAddress, role: 3 },
          { address: SYSTEM_PROGRAM_ID, role: 0 },
        ],
        data: instructionData,
      }

      setStatus('Please sign the transaction in your wallet...')

      const result = await sendTransaction({
        instructions: [depositInstruction],
      })

      if (result) {
        console.log('[Deposit] Success:', result)
        setStatus(`Deposit successful! ${amount} SOL deposited.`)
        onDepositComplete(depositNote)
      } else {
        throw new Error('Transaction failed')
      }
    } catch (error) {
      console.error('[Deposit] Error:', error)
      setStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-[#1a1f2e] border border-[#2d3748] p-6 rounded-lg">
      <h2 className="text-xl font-semibold text-white mb-2">Deposit</h2>
      <p className="text-gray-400 text-sm mb-5">
        Enter an amount to deposit. A deposit note will be generated automatically.
      </p>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Amount (SOL)
          </label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min="0.001"
            step="0.01"
            className="w-full px-3 py-2 border border-[#2d3748] rounded bg-[#0e1116]"
            disabled={loading || isSending}
          />
          <p className="text-xs text-gray-500 mt-1">Minimum: 0.001 SOL</p>
        </div>

        {status && (
          <div className={`p-3 rounded text-sm ${
            status.includes('Error')
              ? 'bg-red-900/30 text-red-400 border border-red-800'
              : 'bg-[#14F195]/10 text-[#14F195] border border-[#14F195]/30'
          }`}>
            {status}
          </div>
        )}

        <button
          onClick={handleDeposit}
          disabled={!walletAddress || loading || isSending || !amount}
          className="w-full px-4 py-3 btn-success text-white rounded font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading || isSending ? 'Processing...' : `Deposit ${amount} SOL`}
        </button>
      </div>
    </div>
  )
}
