import { useState } from 'react'
import { useWalletConnection, useBalance } from '@solana/react-hooks'
import { getWalletAddress, formatSol } from '../utils'
import { API_URL, LAMPORTS_PER_SOL } from '../constants'

export function BalanceDisplay() {
  const { wallet } = useWalletConnection()
  const [airdropStatus, setAirdropStatus] = useState('')

  const walletAddress = getWalletAddress(wallet)
  const balanceData = useBalance(walletAddress || undefined)

  const requestAirdrop = async () => {
    if (!walletAddress) return
    setAirdropStatus('Requesting airdrop...')
    try {
      const response = await fetch(`${API_URL}/api/airdrop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: walletAddress, amount: Number(LAMPORTS_PER_SOL) })
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Airdrop failed')
      }

      setAirdropStatus('Airdrop successful!')
      setTimeout(() => setAirdropStatus(''), 3000)
    } catch (e) {
      setAirdropStatus(`Airdrop failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
  }

  const displayBalance = balanceData?.lamports != null
    ? formatSol(balanceData.lamports)
    : null

  return (
    <div className="bg-[#1a1f2e] border border-[#2d3748] rounded-lg p-4 mb-6 flex items-center justify-between">
      <div>
        <span className="text-gray-400">Balance: </span>
        <span className="font-semibold text-white">
          {balanceData?.fetching ? 'Loading...' : displayBalance !== null ? `${displayBalance} SOL` : 'N/A'}
        </span>
        <span className="text-gray-500 text-sm ml-2">(Devnet)</span>
      </div>
      <div className="flex items-center gap-4">
        {airdropStatus && (
          <span className={`text-sm ${airdropStatus.includes('failed') ? 'text-red-400' : 'text-[#14F195]'}`}>
            {airdropStatus}
          </span>
        )}
        <button
          onClick={requestAirdrop}
          className="px-4 py-2 text-sm text-gray-300 border border-[#2d3748] rounded hover:bg-[#2d3748] transition-colors"
        >
          Request Airdrop
        </button>
      </div>
    </div>
  )
}
