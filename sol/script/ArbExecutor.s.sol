// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";

contract ArbExecutorScript is Script {
    address internal constant DEFAULT_BALANCER_VAULT =
        0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address internal constant DEFAULT_UNISWAP_V3_FACTORY =
        0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address internal constant DEFAULT_SUSHISWAP_V3_FACTORY =
        0x917933899c6a5F8E37F31E19f92CdBFF7e8FF0e2;
    address internal constant DEFAULT_QUICKSWAP_V3_FACTORY =
        0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28;
    address internal constant DEFAULT_KYBER_ELASTIC_FACTORY =
        0x5F1dddbf348aC2fbe22a163e30F99F9ECE3DD50a;

    function run() external returns (ArbExecutor executor) {
        address owner = vm.envAddress("OWNER");
        address balancerVault = vm.envOr("BALANCER_VAULT", DEFAULT_BALANCER_VAULT);
        address uniswapV3Factory =
            vm.envOr("UNISWAP_V3_FACTORY", DEFAULT_UNISWAP_V3_FACTORY);
        address sushiV3Factory =
            vm.envOr("SUSHISWAP_V3_FACTORY", DEFAULT_SUSHISWAP_V3_FACTORY);
        address quickswapV3Factory =
            vm.envOr("QUICKSWAP_V3_FACTORY", DEFAULT_QUICKSWAP_V3_FACTORY);
        address kyberElasticFactory =
            vm.envOr("KYBER_ELASTIC_FACTORY", DEFAULT_KYBER_ELASTIC_FACTORY);
        address initialOperator = vm.envOr("INITIAL_OPERATOR", address(0));

        vm.startBroadcast();

        executor = new ArbExecutor(
            owner,
            balancerVault,
            uniswapV3Factory,
            sushiV3Factory,
            quickswapV3Factory,
            kyberElasticFactory
        );

        // Post-deployment operator setup (only works if broadcaster == owner)
        if (initialOperator != address(0)) {
            if (msg.sender == owner) {
                executor.setOperator(initialOperator, true);
                console2.log("Initial operator granted:", initialOperator);
            } else {
                console2.log("NOTE: INITIAL_OPERATOR was provided but broadcaster != owner.");
                console2.log("      Call setOperator(operator, true) manually from the owner account.");
            }
        }

        vm.stopBroadcast();

        console2.log("ArbExecutor deployed:", address(executor));
        console2.log("owner:", owner);
        if (initialOperator != address(0) && msg.sender == owner) {
            console2.log("operator:", initialOperator);
        }
        console2.log("balancerVault:", balancerVault);
        console2.log("uniswapV3Factory:", uniswapV3Factory);
        console2.log("sushiV3Factory:", sushiV3Factory);
        console2.log("quickswapV3Factory:", quickswapV3Factory);
        console2.log("kyberElasticFactory:", kyberElasticFactory);
    }
}