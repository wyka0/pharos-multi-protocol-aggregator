// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/* =============================================================================
   PharosVaultSuite.sol
   =============================================================================
   Self-contained multi-vault protocol suite for the Pharos Multi-Protocol
   Aggregator (Harbor-style cross-vault query & non-custodial action router)
   on Pharos Atlantic Testnet (chainId 688689).

   The file intentionally has ZERO imports so it compiles as a single solc
   unit via solc-js. It contains:

     SuiteToken              - test underlying asset ("tUSDC", 6 decimals)
     SuiteVaultBase          - shared ERC-4626-style vault mechanics:
                               share accounting, entry/exit fees, time-based
                               yield accrual via a virtual debt pool, instant
                               liquidity cap (cash-bounded withdrawals),
                               pause/circuit-breaker state.
     HarborLendVault         - Protocol A: kinked-utilization lending vault.
                               0 bps entry / 5 bps exit. APY rises with
                               utilization (borrower demand), falls when new
                               cash is supplied (post-deposit dilution).
     AtlanticPrimeStaking    - Protocol B: tiered-yield staking vault with a
                               capacity-bounded dilution curve. 10 bps entry /
                               0 bps exit. Highest headline APY, but large
                               deposits compress the effective rate.
     PharosRwaTreasury       - Protocol C: institutional RWA T-Bill vault.
                               Stable floor APY, 0/0 fees, deep liquidity
                               (zero utilization slippage) and an explicit
                               on-chain paused / circuit-breaker state.
     AggregatorRouteAnchor   - on-chain keccak256 commitment anchor: the
                               unsigned Harbor payload presented to the wallet
                               is bound to the multi-venue comparison table
                               shown in the UI (quote-to-payload commitment).
     PharosVaultSuite        - facade that deploys the whole ecosystem in one
                               constructor and exposes admin controls used by
                               the fault-isolation demo (pause, borrow-draw
                               simulation, time-warp accrual).

   All three vaults accept the SAME underlying asset (SuiteToken) so the user
   experiences a single unified interface across three distinct protocols.
   ========================================================================== */

uint256 constant WAD = 1e18;
uint256 constant BPS_DENOMINATOR = 10_000;
uint256 constant SECONDS_PER_YEAR = 365 days;

/* -------------------------------------------------------------------------- */
/* SuiteToken - minimal burnable ERC-20 (6 decimals) used as underlying asset  */
/* -------------------------------------------------------------------------- */
contract SuiteToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public immutable minter;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, address minter_) {
        name = name_;
        symbol = symbol_;
        minter = minter_;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "SuiteToken: only minter");
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "SuiteToken: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "SuiteToken: insufficient balance");
        require(to != address(0), "SuiteToken: zero recipient");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/* -------------------------------------------------------------------------- */
/* SuiteVaultBase - shared ERC-4626-style mechanics                            */
/*                                                                            */
/* Accounting model                                                            */
/* ---------------                                                             */
/*   totalAssets = cash + debtOwed.                                            */
/*   `cash`     : idle underlying held by the vault (instant liquidity).       */
/*   `debtOwed` : virtual interest-bearing pool (borrower debt for the lending */
/*                vault, reward pool for staking/RWA). Yield accrual grows     */
/*                debtOwed, which grows the share price; withdrawals pay out   */
/*                of cash and are therefore hard-capped by available cash      */
/*                ("instant liquidity cap").                                   */
/* -------------------------------------------------------------------------- */
abstract contract SuiteVaultBase {
    string public vaultName;
    string public vaultSymbol; // share token
    SuiteToken public immutable asset;

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    mapping(address => mapping(address => uint256)) public shareAllowance;
    mapping(address => uint256) public principalOf; // net assets deposited (fee-adjusted)

    uint256 public cash;
    uint256 public debtOwed;
    uint256 public lastAccrual;

    uint256 public entryFeeBps;
    uint256 public exitFeeBps;

    bool public paused;
    string public pauseReason;

    address public immutable admin; // the PharosVaultSuite facade

    event Deposited(address indexed by, address indexed to, uint256 assetsIn, uint256 entryFee, uint256 sharesMinted);
    event Withdrawn(address indexed by, address indexed to, uint256 grossAssets, uint256 exitFee, uint256 netAssets, uint256 sharesBurned);
    event InterestAccrued(uint256 elapsedSeconds, uint256 interestAmount, uint256 rateBps);
    event Paused(bool paused, string reason);
    event ShareApproval(address indexed owner, address indexed spender, uint256 value);

    modifier onlyAdmin() {
        require(msg.sender == admin, "SuiteVault: only suite admin");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "SuiteVault: paused");
        _;
    }

    bool private locked;

    modifier nonReentrant() {
        require(!locked, "SuiteVault: reentrant");
        locked = true;
        _;
        locked = false;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        SuiteToken asset_,
        address admin_,
        uint256 entryFeeBps_,
        uint256 exitFeeBps_
    ) {
        vaultName = name_;
        vaultSymbol = symbol_;
        asset = asset_;
        admin = admin_;
        entryFeeBps = entryFeeBps_;
        exitFeeBps = exitFeeBps_;
        lastAccrual = block.timestamp;
    }

    /* ----------------------------- share math ----------------------------- */

    function totalAssets() public view returns (uint256) {
        return cash + debtOwed;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalShares;
        uint256 ta = totalAssets();
        if (supply == 0 || ta == 0) return assets;
        return (assets * supply) / ta;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalShares;
        if (supply == 0) return shares;
        return (shares * totalAssets()) / supply;
    }

    /* ------------------------------ accrual ------------------------------- */

    /// @dev Protocol-specific instantaneous rate, in bps per year.
    function _currentRateBps() internal view virtual returns (uint256);

    function _accrue() internal {
        uint256 elapsed = block.timestamp - lastAccrual;
        lastAccrual = block.timestamp;
        if (elapsed == 0) return;
        uint256 ta = totalAssets();
        if (ta == 0) return;
        uint256 rate = _currentRateBps();
        uint256 interest = (ta * rate * elapsed) / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
        if (interest > 0) {
            debtOwed += interest;
            emit InterestAccrued(elapsed, interest, rate);
        }
    }

    /// @notice Accrue `secondsDelta` seconds of interest instantly (demo time
    ///         machine used by the verification scenarios; admin-only).
    function accrueInterestFor(uint256 secondsDelta) external onlyAdmin {
        require(secondsDelta > 0 && secondsDelta <= 3650 days, "SuiteVault: bad delta");
        debtOwed += 0; // no-op to keep layout obvious
        uint256 elapsed = secondsDelta;
        uint256 ta = totalAssets();
        require(ta > 0, "SuiteVault: empty");
        uint256 rate = _currentRateBps();
        uint256 interest = (ta * rate * elapsed) / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
        debtOwed += interest;
        emit InterestAccrued(elapsed, interest, rate);
    }

    /* ----------------------------- deposition ----------------------------- */

    function deposit(uint256 assets, address to) external nonReentrant whenNotPaused returns (uint256 sharesMinted) {
        require(assets > 0, "SuiteVault: zero deposit");
        _accrue();

        uint256 entryFee = (assets * entryFeeBps) / BPS_DENOMINATOR;
        uint256 netAssets = assets - entryFee;

        uint256 supply = totalShares;
        uint256 taAfter = totalAssets() + assets; // full amount is held by the vault
        if (supply == 0) {
            sharesMinted = netAssets;
        } else {
            sharesMinted = (netAssets * supply) / taAfter;
        }
        require(sharesMinted > 0, "SuiteVault: zero shares");

        asset.transferFrom(msg.sender, address(this), assets);
        cash += assets;
        totalShares += sharesMinted;
        sharesOf[to] += sharesMinted;
        principalOf[to] += netAssets;

        emit Deposited(msg.sender, to, assets, entryFee, sharesMinted);
    }

    /* ----------------------------- withdrawal ----------------------------- */

    /// @notice Withdraw `netAssets` net of exit fee to `to`.
    function withdraw(uint256 netAssets, address to) external nonReentrant whenNotPaused returns (uint256 sharesBurned) {
        require(netAssets > 0, "SuiteVault: zero withdraw");
        _accrue();

        uint256 feeDenominator = BPS_DENOMINATOR - exitFeeBps;
        uint256 grossAssets = (netAssets * BPS_DENOMINATOR + feeDenominator - 1) / feeDenominator; // ceil
        uint256 exitFee = grossAssets - ((grossAssets * feeDenominator) / BPS_DENOMINATOR);
        if (exitFeeBps == 0) exitFee = 0;

        uint256 userAssets = convertToAssets(sharesOf[msg.sender]);
        require(grossAssets <= userAssets, "SuiteVault: balance exceeded");
        require(grossAssets <= cash, "SuiteVault: instant liquidity cap");

        sharesBurned = convertToShares(grossAssets);
        require(sharesBurned > 0, "SuiteVault: zero shares");
        require(sharesBurned <= sharesOf[msg.sender], "SuiteVault: shares exceeded");

        sharesOf[msg.sender] -= sharesBurned;
        totalShares -= sharesBurned;
        cash -= grossAssets;

        uint256 principal = principalOf[msg.sender];
        if (principal >= grossAssets) {
            principalOf[msg.sender] = principal - grossAssets;
        } else {
            principalOf[msg.sender] = 0; // remainder was accrued yield
        }

        asset.transfer(to, netAssets);
        emit Withdrawn(msg.sender, to, grossAssets, exitFee, netAssets, sharesBurned);
    }

    /// @dev Net (post-exit-fee) amount withdrawable right now, capped by cash.
    function maxWithdraw(address user) public view returns (uint256) {
        uint256 userAssets = convertToAssets(sharesOf[user]);
        uint256 feeDenominator = BPS_DENOMINATOR - exitFeeBps;
        uint256 cap = userAssets;
        if (cash < cap) cap = cash;
        return (cap * feeDenominator) / BPS_DENOMINATOR;
    }

    /* --------------------------- introspection ---------------------------- */

    function utilizationWad() public view virtual returns (uint256);

    function spotApyBps() external view virtual returns (uint256);

    /// @dev Instantaneous APY after a hypothetical deposit of `dx` underlying.
    function postDepositApyBps(uint256 dx) external view virtual returns (uint256);

    function entryFeeFor(uint256 assets) external view returns (uint256) {
        return (assets * entryFeeBps) / BPS_DENOMINATOR;
    }

    function exitFeeFor(uint256 grossAssets) external view returns (uint256) {
        return (grossAssets * exitFeeBps) / BPS_DENOMINATOR;
    }

    /* ----------------------------- admin ops ------------------------------ */

    function setPaused(bool paused_, string calldata reason_) external onlyAdmin {
        paused = paused_;
        pauseReason = reason_;
        emit Paused(paused_, reason_);
    }

    function seedDeposit(uint256 amount) external onlyAdmin {
        require(amount > 0, "SuiteVault: zero seed");
        asset.transferFrom(msg.sender, address(this), amount);
        cash += amount;
        totalShares += amount;
        sharesOf[address(this)] += amount;
        principalOf[address(this)] += amount;
    }
}

/* -------------------------------------------------------------------------- */
/* Protocol A - HarborLendVault (ERC-4626 kinked utilization lending vault)    */
/*                                                                            */
/* Kinked rate model (all bps/yr):                                             */
/*   U <= kink(0.80): rate = base(200) + slope1(1250) * U                      */
/*   U >  kink      : rate = 200 + 1250*0.8 + slope2(94_000) * (U - 0.8)       */
/* i.e. 1200 bps at the kink and 20,000 bps at full utilization. Depositing    */
/* cash lowers U and therefore lowers the post-deposit APY (self-dilution).    */
/* -------------------------------------------------------------------------- */
contract HarborLendVault is SuiteVaultBase {
    uint256 public constant KINK_UTIL_WAD = 8e17; // 0.80
    uint256 public constant BASE_RATE_BPS = 200;
    uint256 public constant SLOPE1_BPS = 1250; // bps added per unit utilization (WAD-scaled)
    uint256 public constant SLOPE2_BPS = 94_000; // bps added per unit utilization beyond kink

    constructor(SuiteToken asset_, address admin_) SuiteVaultBase("Harbor Lend Vault", "jHLV", asset_, admin_, 0, 5) {}

    function utilizationWad() public view override returns (uint256) {
        uint256 ta = totalAssets();
        if (ta == 0) return 0;
        return (debtOwed * WAD) / ta;
    }

    function _kinkedRate(uint256 utilWad) internal pure returns (uint256) {
        if (utilWad <= KINK_UTIL_WAD) {
            return BASE_RATE_BPS + (SLOPE1_BPS * utilWad) / WAD;
        }
        uint256 baseAtKink = BASE_RATE_BPS + (SLOPE1_BPS * KINK_UTIL_WAD) / WAD;
        return baseAtKink + (SLOPE2_BPS * (utilWad - KINK_UTIL_WAD)) / WAD;
    }

    function _currentRateBps() internal view override returns (uint256) {
        return _kinkedRate(utilizationWad());
    }

    function spotApyBps() external view override returns (uint256) {
        return _currentRateBps();
    }

    function postDepositApyBps(uint256 dx) external view override returns (uint256) {
        uint256 ta = totalAssets() + dx;
        if (ta == 0) return BASE_RATE_BPS;
        return _kinkedRate((debtOwed * WAD) / ta);
    }

    /// @notice Move `amount` from idle cash into borrower debt (raises
    ///         utilization). Admin-only demo control for utilization dynamics.
    function simulateBorrowDraw(uint256 amount) external onlyAdmin {
        require(amount <= cash, "HarborLend: insufficient cash");
        cash -= amount;
        debtOwed += amount;
    }

    /// @notice Repay borrower debt back into idle cash (lowers utilization).
    function simulateBorrowRepay(uint256 amount) external onlyAdmin {
        require(amount <= debtOwed, "HarborLend: insufficient debt");
        debtOwed -= amount;
        cash += amount;
    }
}

/* -------------------------------------------------------------------------- */
/* Protocol B - AtlanticPrimeStaking (tiered staking vault w/ dilution curve)  */
/*                                                                            */
/* Dilution model (all bps/yr):                                                */
/*   U = totalAssets / capacity                                                */
/*   rate = base(940) * (1 - 0.35 * U^2)                                       */
/* Large deposits push U toward 1.0 and compress the effective rate toward     */
/* 611 bps, so whales face heavy opportunity cost vs. the 940 bps headline.    */
/* -------------------------------------------------------------------------- */
contract AtlanticPrimeStaking is SuiteVaultBase {
    uint256 public constant BASE_APY_BPS = 940;
    uint256 public immutable capacity;
    uint256 public constant DILUTION_STRENGTH_WAD = 35e16; // 0.35

    constructor(SuiteToken asset_, address admin_, uint256 capacity_)
        SuiteVaultBase("Atlantic Prime Staking", "jAPS", asset_, admin_, 10, 0)
    {
        capacity = capacity_;
    }

    function utilizationWad() public view override returns (uint256) {
        uint256 cap = capacity;
        if (cap == 0) return 0;
        uint256 ta = totalAssets();
        if (ta >= cap) return WAD;
        return (ta * WAD) / cap;
    }

    function _dilutedRate(uint256 totalAssetsAfterDx) internal view returns (uint256) {
        uint256 cap = capacity;
        if (cap == 0) return BASE_APY_BPS;
        uint256 uWad = totalAssetsAfterDx >= cap ? WAD : (totalAssetsAfterDx * WAD) / cap;
        // dilution = 1 - strength * U^2  (WAD math)
        uint256 u2 = (uWad * uWad) / WAD;
        uint256 dilution = WAD - (DILUTION_STRENGTH_WAD * u2) / WAD;
        return (BASE_APY_BPS * dilution) / WAD;
    }

    function _currentRateBps() internal view override returns (uint256) {
        return _dilutedRate(totalAssets());
    }

    function spotApyBps() external view override returns (uint256) {
        return _currentRateBps();
    }

    function postDepositApyBps(uint256 dx) external view override returns (uint256) {
        return _dilutedRate(totalAssets() + dx);
    }

    function postDepositApyBpsFor(uint256 totalAssetsAfterDx) external view returns (uint256) {
        return _dilutedRate(totalAssetsAfterDx);
    }
}

/* -------------------------------------------------------------------------- */
/* Protocol C - PharosRwaTreasury (institutional RWA T-Bill vault)             */
/*                                                                            */
/* Stable floor APY (780 bps), zero entry/exit fees, deep seeded liquidity     */
/* (zero utilization slippage on large size) and an explicit on-chain          */
/* paused / circuit-breaker state exercised by the fault-isolation demo.       */
/* -------------------------------------------------------------------------- */
contract PharosRwaTreasury is SuiteVaultBase {
    uint256 public constant FLOOR_APY_BPS = 780;

    constructor(SuiteToken asset_, address admin_) SuiteVaultBase("Pharos RWA Treasury", "jRWA", asset_, admin_, 0, 0) {}

    function utilizationWad() public view override returns (uint256) {
        // Deep-liquidity T-Bill vault: utilization is informational only and
        // never feeds back into the rate.
        uint256 ta = totalAssets();
        if (ta == 0) return 0;
        return (debtOwed * WAD) / ta;
    }

    function _currentRateBps() internal pure override returns (uint256) {
        return FLOOR_APY_BPS;
    }

    function spotApyBps() external pure override returns (uint256) {
        return FLOOR_APY_BPS;
    }

    function postDepositApyBps(uint256) external pure override returns (uint256) {
        return FLOOR_APY_BPS; // zero slippage on any size
    }
}

/* -------------------------------------------------------------------------- */
/* AggregatorRouteAnchor - keccak256 quote-to-payload commitment anchor        */
/* -------------------------------------------------------------------------- */
contract AggregatorRouteAnchor {
    struct AnchorRecord {
        bytes32 commitment;
        address anchoredBy;
        uint256 blockNumber;
        uint256 timestamp;
        string memo;
    }

    mapping(bytes32 => AnchorRecord) private records;
    bytes32[] private allCommitments;

    event CommitmentAnchored(bytes32 indexed commitment, address indexed anchoredBy, uint256 blockNumber, string memo);

    function anchorCommitment(bytes32 commitment, string calldata memo) external returns (bool firstAnchor) {
        require(commitment != bytes32(0), "Anchor: zero commitment");
        AnchorRecord storage r = records[commitment];
        firstAnchor = r.timestamp == 0;
        if (firstAnchor) {
            r.commitment = commitment;
            r.anchoredBy = msg.sender;
            r.blockNumber = block.number;
            r.timestamp = block.timestamp;
            r.memo = memo;
            allCommitments.push(commitment);
            emit CommitmentAnchored(commitment, msg.sender, block.number, memo);
        }
    }

    function isAnchored(bytes32 commitment) external view returns (bool) {
        return records[commitment].timestamp != 0;
    }

    function getAnchor(bytes32 commitment) external view returns (AnchorRecord memory) {
        return records[commitment];
    }

    function totalAnchors() external view returns (uint256) {
        return allCommitments.length;
    }

    /// @notice Off-chain verifier helper: does `encoded` hash to `expected`?
    function verifyKeccak(bytes calldata encoded, bytes32 expected) external pure returns (bool) {
        return keccak256(encoded) == expected;
    }
}

/* -------------------------------------------------------------------------- */
/* PharosVaultSuite - one-shot ecosystem facade                                */
/* -------------------------------------------------------------------------- */
contract PharosVaultSuite {
    SuiteToken public immutable tUSDC;
    HarborLendVault public immutable harborLend;
    AtlanticPrimeStaking public immutable primeStaking;
    PharosRwaTreasury public immutable rwaTreasury;
    AggregatorRouteAnchor public immutable routeAnchor;
    address public immutable deployer;

    uint256 public constant USER_MINT = 250_000e6; // 250k tUSDC to the deployer/user
    uint256 public constant HARBOR_SEED_CASH = 45_000e6; // post-draw idle cash target
    uint256 public constant HARBOR_SEED_BORROWED = 37_000e6; // virtual debt -> U ~ 45.1% -> ~764 bps
    uint256 public constant PRIME_SEED_DEPOSITS = 10_000e6;
    uint256 public constant PRIME_CAPACITY = 60_000e6;
    uint256 public constant RWA_SEED_LIQUIDITY = 220_000e6;

    constructor(address deployer_) {
        require(deployer_ != address(0), "Suite: zero deployer");
        deployer = deployer_;

        tUSDC = new SuiteToken("Pharos Test USDC", "tUSDC", address(this));
        harborLend = new HarborLendVault(tUSDC, address(this));
        primeStaking = new AtlanticPrimeStaking(tUSDC, address(this), PRIME_CAPACITY);
        rwaTreasury = new PharosRwaTreasury(tUSDC, address(this));
        routeAnchor = new AggregatorRouteAnchor();

        tUSDC.mint(address(this), USER_MINT + HARBOR_SEED_CASH + HARBOR_SEED_BORROWED + PRIME_SEED_DEPOSITS + RWA_SEED_LIQUIDITY);

        tUSDC.approve(address(harborLend), type(uint256).max);
        tUSDC.approve(address(primeStaking), type(uint256).max);
        tUSDC.approve(address(rwaTreasury), type(uint256).max);

        // Protocol A seed: 82k total -> 45k idle cash + 37k virtual borrower debt
        harborLend.seedDeposit(HARBOR_SEED_CASH + HARBOR_SEED_BORROWED);
        harborLend.simulateBorrowDraw(HARBOR_SEED_BORROWED);

        // Protocol B seed: 10k of a 60k capacity => U ~ 16.7% (room to dilute)
        primeStaking.seedDeposit(PRIME_SEED_DEPOSITS);

        // Protocol C seed: deep 220k liquidity => zero slippage on demo sizes
        rwaTreasury.seedDeposit(RWA_SEED_LIQUIDITY);

        tUSDC.mint(deployer_, USER_MINT);
    }

    /* --------------------------- introspection ---------------------------- */

    function allVaults() external view returns (address[3] memory) {
        return [address(harborLend), address(primeStaking), address(rwaTreasury)];
    }

    function protocolNames() external pure returns (string[3] memory) {
        return ["HarborLendVault", "AtlanticPrimeStaking", "PharosRwaTreasury"];
    }

    function underlying() external view returns (address) {
        return address(tUSDC);
    }

    /* ------------------- demo / chaos-drill admin controls ----------------- */

    modifier onlyDeployer() {
        require(msg.sender == deployer, "Suite: only deployer");
        _;
    }

    function vaultAt(uint8 index) public view returns (SuiteVaultBase) {
        if (index == 0) return harborLend;
        if (index == 1) return primeStaking;
        require(index == 2, "Suite: bad index");
        return rwaTreasury;
    }

    /// @notice On-chain circuit breaker toggle for the fault-isolation demo.
    function pauseProtocol(uint8 index, bool paused, string calldata reason) external onlyDeployer {
        vaultAt(index).setPaused(paused, reason);
    }

    /// @notice Demo time machine: instantly accrue `secondsDelta` of yield.
    function warpAccrual(uint8 index, uint256 secondsDelta) external onlyDeployer {
        vaultAt(index).accrueInterestFor(secondsDelta);
    }

    /// @notice Push utilization up/down on the lending vault (demo control).
    function setHarborBorrowed(uint256 borrowedAmount) external onlyDeployer {
        uint256 current = harborLend.debtOwed();
        if (borrowedAmount > current) {
            harborLend.simulateBorrowDraw(borrowedAmount - current);
        } else if (borrowedAmount < current) {
            harborLend.simulateBorrowRepay(current - borrowedAmount);
        }
    }
}
